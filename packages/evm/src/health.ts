import type { RpcEndpoint } from "./endpoints.ts";
import type { ClassifiedRpcError } from "./normalize.ts";

export type CircuitState = "closed" | "open" | "halfOpen";

export interface EndpointCapabilities {
  stateOverrides: boolean | null;
  maxPriorityFeePerGas: boolean | null;
  maxLogRange: bigint | null;
}

export interface EndpointHealth {
  circuit: CircuitState;
  consecutiveFailures: number;
  ewmaLatencyMs: number | null;
  height: bigint | null;
  quarantined: boolean;
  cooldownUntil: number;
  openCount: number;
  probeInFlight: boolean;
  admitted: boolean;
  capabilities: EndpointCapabilities;
}

export interface RpcPoolSnapshot {
  readonly endpoints: number;
  readonly healthy: number;
  readonly quarantined: number;
  readonly open: number;
}

const EWMA_ALPHA = 0.3;
const FAILURES_TO_OPEN = 3;
const MAX_COOLDOWN_MS = 120_000;

export class HealthBook {
  private readonly states = new Map<string, EndpointHealth>();
  private readonly now: () => number;
  private readonly random: () => number;

  public constructor(endpoints: readonly RpcEndpoint[], now: () => number, random: () => number) {
    this.now = now;
    this.random = random;
    for (const endpoint of endpoints) {
      this.states.set(endpoint.url, {
        circuit: "closed",
        consecutiveFailures: 0,
        ewmaLatencyMs: null,
        height: null,
        quarantined: false,
        cooldownUntil: 0,
        openCount: 0,
        probeInFlight: false,
        admitted: false,
        capabilities: { stateOverrides: null, maxPriorityFeePerGas: null, maxLogRange: null },
      });
    }
  }

  public get(url: string): EndpointHealth {
    const state = this.states.get(url);
    if (state === undefined) throw new Error(`Unknown RPC endpoint ${url}`);
    return state;
  }

  public admit(url: string, expectedChainId: number, observedChainId: number): void {
    const state = this.get(url);
    if (observedChainId !== expectedChainId) {
      state.quarantined = true;
      state.admitted = false;
      return;
    }
    state.admitted = true;
  }

  public recordHeight(url: string, height: bigint): void {
    const state = this.get(url);
    if (state.height === null || height > state.height) state.height = height;
  }

  public recordSuccess(url: string, latencyMs: number, height?: bigint): void {
    const state = this.get(url);
    state.consecutiveFailures = 0;
    state.circuit = "closed";
    state.probeInFlight = false;
    state.ewmaLatencyMs = state.ewmaLatencyMs === null
      ? latencyMs
      : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * state.ewmaLatencyMs;
    if (height !== undefined) this.recordHeight(url, height);
  }

  public recordFailure(url: string, error: ClassifiedRpcError): void {
    const state = this.get(url);
    state.probeInFlight = false;
    if (error.class === "unsupportedMethod") return;
    if (error.class === "rangeTooLarge") return;
    if (error.class === "executionReverted" || error.class === "invalidRequest" || error.class === "alreadyKnown") return;
    if (error.class === "rateLimited") {
      this.open(state, error.retryAfterMs ?? this.cooldownMs(state));
      return;
    }
    state.consecutiveFailures += 1;
    if (state.circuit === "halfOpen" || state.consecutiveFailures >= FAILURES_TO_OPEN) {
      this.open(state, this.cooldownMs(state));
    }
  }

  public learnUnsupported(url: string, method: string, requiresStateOverrides: boolean): void {
    const state = this.get(url);
    if (requiresStateOverrides) state.capabilities.stateOverrides = false;
    if (method === "eth_maxPriorityFeePerGas") state.capabilities.maxPriorityFeePerGas = false;
  }

  public learnStateOverrides(url: string, supported: boolean): void {
    this.get(url).capabilities.stateOverrides = supported;
  }

  public learnMaxLogRange(url: string, span: bigint): void {
    const state = this.get(url);
    if (span <= 0n) return;
    const next = span - 1n;
    if (state.capabilities.maxLogRange === null || next < state.capabilities.maxLogRange) {
      state.capabilities.maxLogRange = next;
    }
  }

  public canSelect(url: string): boolean {
    const state = this.get(url);
    const now = this.now();
    if (state.quarantined) return false;
    if (state.circuit === "open" && now < state.cooldownUntil) return false;
    if (state.circuit === "halfOpen" && state.probeInFlight) return false;
    return true;
  }

  public beginProbe(url: string): boolean {
    const state = this.get(url);
    const now = this.now();
    if (state.quarantined) return false;
    if (state.circuit === "open" && now >= state.cooldownUntil) {
      state.circuit = "halfOpen";
    }
    if (state.circuit === "open") return false;
    if (state.circuit === "halfOpen") {
      if (state.probeInFlight) return false;
      state.probeInFlight = true;
    }
    return true;
  }

  public snapshot(): RpcPoolSnapshot {
    let healthy = 0;
    let quarantined = 0;
    let open = 0;
    const now = this.now();
    for (const state of this.states.values()) {
      if (state.quarantined) {
        quarantined += 1;
        continue;
      }
      if (state.circuit === "open" && now < state.cooldownUntil) {
        open += 1;
        continue;
      }
      healthy += 1;
    }
    return { endpoints: this.states.size, healthy, quarantined, open };
  }

  private open(state: EndpointHealth, cooldownMs: number): void {
    state.circuit = "open";
    state.openCount += 1;
    state.cooldownUntil = this.now() + cooldownMs;
  }

  private cooldownMs(state: EndpointHealth): number {
    const exponential = 1_000 * (2 ** Math.min(state.openCount, 10));
    const capped = Math.min(MAX_COOLDOWN_MS, exponential);
    return Math.floor(capped * (0.8 + this.random() * 0.4));
  }
}
