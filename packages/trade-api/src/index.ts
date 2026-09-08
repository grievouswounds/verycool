import type { SQL } from "bun";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  addressSchema, AppError, hashSchema, hexSchema, parseTokenAmount, positiveAmountSchema, quantitySchema,
} from "@aqua/core";
import type {
  Address, AuthenticatedPrincipal, Hash, Hex, RpcCall, RpcPort, RuntimeManifest, SubscribedTradesWipe,
  TokenReference, TradePreviewRequest, TradesListQuery, TradingOrder, UnsignedTransaction,
} from "@aqua/core";
import { tradingOrderSchema } from "@aqua/core";
import {
  decodeAddress, decodeUint256, encodeActionNonce, encodeAllowance, encodeApprove, encodeBalanceOf, encodeDelegationNonce,
  encodeDeployVault, encodeExecuteVaultAction, encodePredictVault, encodeRegisterDelegation, hashAddressArray,
  hashUint256Array, hexToBytes, keccakHex, quantityToHex, recoverAgentBindingAddress, recoverDelegationAddress,
  recoverTypedDataAddress,
} from "@aqua/evm";
import type { Eip712TypedData, VaultAction, VaultDeployment } from "@aqua/evm";
import type { TradingService } from "@aqua/orderbook";
import type { QuoterService, TokenSearchResult } from "@aqua/quoter";
import { exactPermit2UpfrontRequirement, paymentIdentifier } from "@aqua/x402-adapter";
import { z } from "zod";

interface AgentBindingRow { readonly agent: Address }
interface AgentChallengeRow { readonly owner: Address; readonly agent: Address; readonly message: string; readonly expires_at: Date; readonly used_at: Date | null }
interface PreviewRow { readonly id: string; readonly preview_hash: Hash; readonly owner: Address; readonly agent: Address; readonly state: string; readonly request: TradePreviewRequest; readonly response: Readonly<Record<string, unknown>>; readonly lifecycle_nonce: Hash; readonly expires_at: Date; readonly submitted_at: Date | null }
interface OperationRow { readonly id: string; readonly state: string; readonly payment_transaction: Hash | null; readonly deployment_transaction: Hash | null; readonly lifecycle_transaction: Hash | null; readonly action_payload: unknown; readonly lifecycle_signature: Hex | null; readonly prerequisite_transactions: unknown }
interface DelegationPreviewRow { readonly id: string; readonly preview_hash: Hash; readonly owner: Address; readonly agent: Address; readonly token: Address; readonly max_per_order: string; readonly max_per_day: string; readonly valid_until: Date; readonly typed_data: Readonly<Record<string, unknown>>; readonly expires_at: Date; readonly used_at: Date | null }
interface DelegationRow { readonly max_per_order: string; readonly max_per_day: string; readonly spent_today: string; readonly day_number: string; readonly valid_until: Date }
interface OwnTradeRow { readonly id: string; readonly status: string; readonly owner: Address; readonly agent: Address; readonly sell_token: Address; readonly buy_token: Address; readonly sell_amount: string; readonly funded_amount: string; readonly payment_transaction: Hash | null; readonly lifecycle_transaction: Hash | null; readonly kind: string; readonly occurred_at: Date; readonly updated_at: Date }
interface SubscribedTradeRow { readonly id: string; readonly watched_address: Address; readonly transaction_hash: Hash; readonly sell_token: Address; readonly buy_token: Address; readonly sell_amount: string; readonly buy_amount: string; readonly occurred_at: Date; readonly updated_at: Date }
export interface TransactionRelay { relay(call: RpcCall): Promise<Hash> }

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) { const array: unknown[] = value; return `[${array.map((item: unknown) => canonical(item)).join(",")}]`; }
  if (typeof value !== "object") throw new Error("Preview contains a non-JSON value");
  const object = z.record(z.string(), z.unknown()).parse(value);
  return `{${Object.entries(object).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]: [string, unknown]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};
const digest = (value: unknown): Hash => keccakHex(new TextEncoder().encode(canonical(value)));
const randomHash = (): Hash => hashSchema.parse(`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
const typedDomain = (manifest: RuntimeManifest) => ({ name: "Aqua Ledger Agent Vault", version: "1", chainId: manifest.chain.id, verifyingContract: manifest.contracts.orderVaultFactory.address });

interface ResolvedToken {
  readonly address: Address; readonly name: string; readonly symbol: string; readonly decimals: number;
  readonly chainId: number; readonly nativeReference: boolean; readonly codeHash: Hash; readonly spotPrice: string | null;
}
const storedTradeSchema = z.looseObject({ sellToken: addressSchema, buyToken: addressSchema, amount: z.object({ side: z.enum(["sell", "buy"]), value: positiveAmountSchema }).strict() });
const isCandidates = (value: ResolvedToken | readonly TokenSearchResult[]): value is readonly TokenSearchResult[] => Array.isArray(value);

export interface TradePreviewCreated { readonly status: 201; readonly body: Readonly<Record<string, unknown>> }
export interface TradePreviewAmbiguous { readonly status: 300; readonly body: { readonly error: "ambiguousToken"; readonly field: "sellToken" | "buyToken"; readonly candidates: readonly TokenSearchResult[] } }
export type TradePreviewResult = TradePreviewCreated | TradePreviewAmbiguous;
export interface TradeSubmissionResult { readonly status: 200 | 202 | 402; readonly body: Readonly<Record<string, unknown>>; readonly paymentRequired?: PaymentRequired; readonly paymentResponse?: SettleResponse }

export class TradeApiService {
  private readonly facilitator: HTTPFacilitatorClient;
  private readonly db: SQL;
  private readonly rpc: RpcPort;
  private readonly trading: TradingService;
  private readonly quoter: QuoterService;
  private readonly manifest: RuntimeManifest;
  private readonly relay: TransactionRelay;
  public constructor(
    db: SQL, rpc: RpcPort, trading: TradingService, quoter: QuoterService, manifest: RuntimeManifest, relay: TransactionRelay,
  ) { this.db = db; this.rpc = rpc; this.trading = trading; this.quoter = quoter; this.manifest = manifest; this.relay = relay; this.facilitator = new HTTPFacilitatorClient({ url: manifest.services.facilitatorUrl, timeoutMs: 30_000 }); }

  public async initialize(): Promise<void> { await this.db`SELECT 1`; }

  public async createAgentChallenge(owner: Address, agent: Address) {
    const id = crypto.randomUUID(); const nonce = randomHash(); const expiresAt = new Date(Date.now() + 300_000);
    const typedData = { domain: typedDomain(this.manifest), primaryType: "AgentBinding", types: { AgentBinding: [
      { name: "owner", type: "address" }, { name: "agent", type: "address" }, { name: "nonce", type: "bytes32" }, { name: "validBefore", type: "uint256" },
    ] }, message: { owner, agent, nonce, validBefore: String(Math.floor(expiresAt.getTime() / 1000)) } };
    await this.db`INSERT INTO agent_binding_challenges(id,owner,agent,message,expires_at) VALUES(${id},${owner},${agent},${JSON.stringify(typedData)},${expiresAt})`;
    return { challengeId: id, typedData, expiresAt: expiresAt.toISOString() };
  }

  public async bindAgent(owner: Address, challengeId: string, agent: Address, signature: Hex) {
    const rows = await this.db<AgentChallengeRow[]>`SELECT owner,agent,message,expires_at,used_at FROM agent_binding_challenges WHERE id=${challengeId} FOR UPDATE`;
    const challenge = rows[0];
    if (challenge?.owner !== owner || challenge.agent !== agent || challenge.used_at !== null || challenge.expires_at <= new Date()) throw new AppError(409, "urn:aqua:error:agent-challenge", "Agent binding challenge is missing, expired, or already used");
    const parsed = z.object({ message: z.object({ nonce: hashSchema, validBefore: z.string().regex(/^\d+$/u) }).loose() }).loose().parse(JSON.parse(challenge.message));
    const recovered = recoverAgentBindingAddress({ chainId: this.manifest.chain.id, verifyingContract: this.manifest.contracts.orderVaultFactory.address, owner, agent, nonce: parsed.message.nonce, validBefore: BigInt(parsed.message.validBefore) }, signature);
    if (recovered !== agent) throw new AppError(401, "urn:aqua:error:agent-proof", "Agent proof-of-possession signature is invalid");
    await this.db.begin(async (transaction) => {
      await transaction`UPDATE agent_binding_challenges SET used_at=now() WHERE id=${challengeId} AND used_at IS NULL`;
      await transaction`INSERT INTO owner_agent_bindings(owner,agent,bound_at,revoked_at) VALUES(${owner},${agent},now(),NULL) ON CONFLICT(owner) DO UPDATE SET agent=EXCLUDED.agent,bound_at=EXCLUDED.bound_at,revoked_at=NULL`;
    });
    return { owner, agent, bound: true };
  }

  private async boundAgent(owner: Address): Promise<Address> {
    const rows = await this.db<AgentBindingRow[]>`SELECT agent FROM owner_agent_bindings WHERE owner=${owner} AND revoked_at IS NULL`;
    const agent = rows[0]?.agent;
    if (agent === undefined) throw new AppError(409, "urn:aqua:error:agent-not-bound", "Provision and bind the local Ledger Key Ring agent before trading");
    return agent;
  }

  public async createDelegationPreview(owner: Address, input: { readonly agent: Address; readonly token: Address; readonly maxPerOrder: string; readonly maxPerDay: string; readonly expiresAt: string }) {
    if (await this.boundAgent(owner) !== input.agent) throw new AppError(409, "urn:aqua:error:agent-binding", "Delegation agent is not the owner's bound agent");
    const validUntil = new Date(input.expiresAt); if (validUntil <= new Date() || validUntil.getTime() > Date.now() + 31_536_000_000) throw new AppError(422, "urn:aqua:error:delegation-expiry", "Delegation expiry must be in the future and at most one year away");
    const decimals = await this.rpc.tokenDecimals(input.token); const maxPerOrder = parseTokenAmount(positiveAmountSchema.parse(input.maxPerOrder), decimals); const maxPerDay = parseTokenAmount(positiveAmountSchema.parse(input.maxPerDay), decimals);
    if (maxPerDay < maxPerOrder) throw new AppError(422, "urn:aqua:error:delegation-limit", "maxPerDay must be at least maxPerOrder");
    if (maxPerOrder >= 1n << 128n || maxPerDay >= 1n << 128n) throw new AppError(422, "urn:aqua:error:delegation-limit", "Delegation limit exceeds uint128");
    const nonce = decodeUint256(await this.rpc.call({ to: this.manifest.contracts.orderVaultFactory.address, data: encodeDelegationNonce(owner) }));
    const id = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 300_000);
    const typedData = { domain: typedDomain(this.manifest), primaryType: "Delegation", types: { Delegation: [
      { name: "owner", type: "address" }, { name: "delegate", type: "address" }, { name: "token", type: "address" }, { name: "maxPerOrder", type: "uint256" }, { name: "maxPerDay", type: "uint256" }, { name: "validUntil", type: "uint256" }, { name: "nonce", type: "uint256" },
    ] }, message: { owner, delegate: input.agent, token: input.token, maxPerOrder: maxPerOrder.toString(), maxPerDay: maxPerDay.toString(), validUntil: String(Math.floor(validUntil.getTime() / 1000)), nonce: nonce.toString() } };
    const previewHash = digest({ id, typedData, expiresAt: expiresAt.toISOString() });
    await this.db`INSERT INTO delegation_previews(id,preview_hash,owner,agent,token,max_per_order,max_per_day,valid_until,typed_data,expires_at) VALUES(${id},${previewHash},${owner},${input.agent},${input.token},${maxPerOrder.toString()},${maxPerDay.toString()},${validUntil},${JSON.stringify(typedData)},${expiresAt})`;
    return { previewId: id, previewHash, expiresAt: expiresAt.toISOString(), typedData, normalized: { ...input, maxPerOrderUnits: maxPerOrder.toString(), maxPerDayUnits: maxPerDay.toString() } };
  }

  public async submitDelegation(owner: Address, input: { readonly previewId: string; readonly previewHash: Hash; readonly ownerSignature: Hex }) {
    const rows = await this.db<DelegationPreviewRow[]>`SELECT id,preview_hash,owner,agent,token,max_per_order::text,max_per_day::text,valid_until,typed_data,expires_at,used_at FROM delegation_previews WHERE id=${input.previewId}`;
    const preview = rows[0]; if (preview?.owner !== owner || preview.preview_hash !== input.previewHash || preview.used_at !== null || preview.expires_at <= new Date()) throw new AppError(409, "urn:aqua:error:delegation-preview", "Delegation preview is missing, altered, expired, or already used");
    const message = z.object({ message: z.object({ nonce: z.string().regex(/^\d+$/u) }).loose() }).loose().parse(preview.typed_data).message;
    const value = { chainId: this.manifest.chain.id, verifyingContract: this.manifest.contracts.orderVaultFactory.address, owner, delegate: preview.agent, token: preview.token, maxPerOrder: BigInt(preview.max_per_order), maxPerDay: BigInt(preview.max_per_day), validUntil: BigInt(Math.floor(preview.valid_until.getTime() / 1000)), nonce: BigInt(message.nonce) };
    if (recoverDelegationAddress(value, input.ownerSignature) !== owner) throw new AppError(401, "urn:aqua:error:delegation-signature", "Delegation signature was not made by the Ledger owner");
    const transactionHash = await this.relay.relay({ to: this.manifest.contracts.orderVaultFactory.address, data: encodeRegisterDelegation({ ...value, signature: input.ownerSignature }) });
    await this.db.begin(async (transaction) => {
      await transaction`UPDATE delegation_previews SET used_at=now() WHERE id=${preview.id} AND used_at IS NULL`;
      await transaction`INSERT INTO delegation_projections(owner,agent,token,max_per_order,max_per_day,spent_today,day_number,valid_until,registration_transaction,updated_at) VALUES(${owner},${preview.agent},${preview.token},${preview.max_per_order},${preview.max_per_day},0,${String(Math.floor(Date.now()/86_400_000))},${preview.valid_until},${transactionHash},now()) ON CONFLICT(owner,agent,token) DO UPDATE SET max_per_order=EXCLUDED.max_per_order,max_per_day=EXCLUDED.max_per_day,spent_today=0,day_number=EXCLUDED.day_number,valid_until=EXCLUDED.valid_until,registration_transaction=EXCLUDED.registration_transaction,updated_at=now()`;
    });
    return { owner, agent: preview.agent, token: preview.token, status: "broadcast", transactionHash };
  }

  private async resolve(reference: TokenReference): Promise<ResolvedToken | readonly TokenSearchResult[]> {
    if (reference.type === "search") {
      const candidates = await this.quoter.searchTokens(reference.query);
      const exact = candidates.filter((item) => item.address.toLowerCase() === reference.query.toLowerCase() || item.symbol.toLowerCase() === reference.query.toLowerCase() || item.name.toLowerCase() === reference.query.toLowerCase());
      if (exact.length !== 1) return candidates;
      return this.resolve({ type: "address", address: addressSchema.parse(exact[0]?.address) });
    }
    const nativeReference = reference.type === "native";
    const address = nativeReference ? this.manifest.contracts.wrappedNativeToken.address : reference.address;
    const code = await this.rpc.getCode(address);
    if (code === "0x") throw new AppError(422, "urn:aqua:error:token-code", "Token address has no contract code");
    const [decimals, symbol, name, spotPrice] = await Promise.all([this.rpc.tokenDecimals(address), this.rpc.tokenSymbol(address), this.rpc.tokenName?.(address) ?? Promise.resolve(nativeReference ? "Ether" : null), this.quoter.optionalPrice(address)]);
    if (symbol === null || name === null) throw new AppError(422, "urn:aqua:error:token-metadata", "Token must expose valid ERC-20 name, symbol, and decimals");
    const codeHash = keccakHex(Buffer.from(code.slice(2), "hex"));
    return { address, name, symbol, decimals, chainId: this.manifest.chain.id, nativeReference, codeHash, spotPrice };
  }

  private toOrder(request: TradePreviewRequest, sell: ResolvedToken, buy: ResolvedToken): TradingOrder {
    const common = { pair: { baseToken: sell.address, quoteToken: buy.address }, side: "sell" as const, size: { denomination: request.amount.side === "sell" ? "base" as const : "quote" as const, amount: request.amount.value } };
    const policy = request.policy;
    if (policy.kind === "market") return tradingOrderSchema.parse({ ...common, kind: "market", timeInForce: { kind: policy.timeInForce }, slippageBps: policy.slippageBps });
    if (policy.kind === "limit") return tradingOrderSchema.parse({ ...common, ...policy });
    if (policy.kind === "stopMarket" || policy.kind === "takeProfitMarket") return tradingOrderSchema.parse({ ...common, kind: policy.kind, triggerPrice: policy.triggerPrice, timeInForce: { kind: policy.timeInForce }, slippageBps: policy.slippageBps });
    if (policy.kind === "stopLimit" || policy.kind === "takeProfitLimit") return tradingOrderSchema.parse({ ...common, ...policy });
    if (policy.kind === "trailingStop") return tradingOrderSchema.parse({ ...common, kind: policy.kind, trail: policy.trail, ...(policy.activationPrice === undefined ? {} : { activationPrice: policy.activationPrice }), timeInForce: { kind: policy.timeInForce }, slippageBps: policy.slippageBps });
    return tradingOrderSchema.parse({ ...common, ...policy });
  }

  private transactions(value: unknown, found: UnsignedTransaction[] = []): readonly UnsignedTransaction[] {
    if (Array.isArray(value)) { const array: unknown[] = value; for (const item of array) this.transactions(item, found); return found; }
    if (typeof value !== "object" || value === null) return found;
    const object = z.record(z.string(), z.unknown()).parse(value);
    const parsed = object["to"] !== undefined && object["data"] !== undefined && object["from"] !== undefined && object["chainId"] !== undefined
      ? zTransaction.safeParse(object) : null;
    if (parsed?.success === true) found.push({ to: parsed.data.to, data: parsed.data.data, value: parsed.data.value, from: parsed.data.from, chainId: parsed.data.chainId, ...(parsed.data.gas === undefined ? {} : { gas: parsed.data.gas }) });
    else for (const item of Object.values(object)) this.transactions(item, found);
    return found;
  }

  private buildVaultAction(preparedBody: Readonly<Record<string, unknown>>, request: TradePreviewRequest, deployment: VaultDeployment, buyToken: Address, vault: Address, nonce: bigint, deadline: bigint): { readonly action: VaultAction; readonly fundingAmount: bigint; readonly kind: "market" | "resting" } {
    const result = preparedEnvelopeSchema.parse(preparedBody).result;
    if (request.policy.kind === "limit" && (request.policy.timeInForce.kind === "gtc" || request.policy.timeInForce.kind === "gtd")) {
      const resting = restingPlanSchema.parse(result);
      const fundingAmount = BigInt(resting.normalizedOrder.sellAmountUnits);
      return { action: { vault, action: 0, strategy: resting.encodedOrder, tokens: [buyToken, deployment.sellToken], amounts: [0n, fundingAmount], nonce, deadline }, fundingAmount, kind: "resting" };
    }
    if (request.policy.kind !== "market" && request.policy.kind !== "limit") throw new AppError(422, "urn:aqua:error:conditional-plan", "Conditional policies require a persisted trigger execution plan and are not yet eligible for vault submission");
    const immediate = immediatePlanSchema.parse(result);
    if (immediate.orderedPlans.length !== 1) throw new AppError(409, "urn:aqua:error:multi-route", "The owner-controlled vault currently requires one atomic Aqua route");
    const route = immediate.orderedPlans[0];
    if (route?.transaction.to !== deployment.app) throw new AppError(409, "urn:aqua:error:route-target", "Prepared market route does not target the immutable vault app");
    const fundingAmount = BigInt(route.requiredInputUnits);
    return { action: { vault, action: 3, strategy: route.transaction.data, tokens: [buyToken, deployment.sellToken], amounts: [BigInt(route.minimumOutputUnits), fundingAmount], nonce, deadline }, fundingAmount, kind: "market" };
  }

  public async createPreview(request: TradePreviewRequest, principal: AuthenticatedPrincipal): Promise<TradePreviewResult> {
    if (request.recipient !== undefined && request.recipient !== principal.address) throw new AppError(422, "urn:aqua:error:recipient", "Trade output must be sent to the Ledger owner");
    const agent = await this.boundAgent(principal.address);
    const sellResult = await this.resolve(request.sellToken); if (isCandidates(sellResult)) return { status: 300, body: { error: "ambiguousToken", field: "sellToken", candidates: sellResult } };
    const buyResult = await this.resolve(request.buyToken); if (isCandidates(buyResult)) return { status: 300, body: { error: "ambiguousToken", field: "buyToken", candidates: buyResult } };
    const sell: ResolvedToken = sellResult; const buy: ResolvedToken = buyResult;
    if (sell.address === buy.address) throw new AppError(422, "urn:aqua:error:token-pair", "Sell and buy token must differ");
    const order = this.toOrder(request, sell, buy);
    const createdAt = new Date(); const expiresAt = new Date(createdAt.getTime() + 300_000);
    const salt = randomHash();
    const deployment: VaultDeployment = { owner: principal.address, delegate: agent, aqua: this.manifest.contracts.aqua.address, app: this.manifest.contracts.limitSwapRouter.address, sellToken: sell.address, salt };
    const vault = decodeAddress(await this.rpc.call({ to: this.manifest.contracts.orderVaultFactory.address, data: encodePredictVault(deployment) }));
    const preparedPrincipal: AuthenticatedPrincipal = { ...principal, address: vault };
    const prepared = await this.trading.execute({ action: "createOrder", order }, preparedPrincipal, null);
    if (prepared.status !== 200) throw new AppError(422, "urn:aqua:error:non-executable-preview", "The trade policy did not produce a concrete immutable vault action");
    const actionNonce = decodeUint256(await this.rpc.call({ to: this.manifest.contracts.orderVaultFactory.address, data: encodeActionNonce(agent) }));
    const vaultPlan = this.buildVaultAction(prepared.body, request, deployment, buy.address, vault, actionNonce, BigInt(Math.floor(expiresAt.getTime() / 1_000)));
    const calls = this.transactions(prepared.body);
    const checks: Readonly<Record<string, unknown>>[] = [];
    for (const transaction of calls) {
      try {
        const [returnData, gas] = await Promise.all([this.rpc.call(transaction), this.rpc.estimateGas(transaction)]);
        checks.push({ name: "rpcCall", target: transaction.to, selector: transaction.data.slice(0, 10), safe: true, gas: gas.toString(), returnData });
      } catch (error: unknown) {
        checks.push({ name: "rpcCall", target: transaction.to, selector: transaction.data.slice(0, 10), safe: true, deferredUntilFunded: true, error: error instanceof Error ? error.message : "simulation deferred" });
      }
    }
    const blockNumber = await this.rpc.blockNumber(); const block = await this.rpc.block(blockNumber);
    const sellAmountUnits = vaultPlan.fundingAmount;
    const balance = decodeUint256(await this.rpc.call({ to: sell.address, data: encodeBalanceOf(agent) }));
    const allowance = decodeUint256(await this.rpc.call({ to: sell.address, data: encodeAllowance(agent, this.manifest.contracts.permit2.address) }));
    const nativeBalance = sell.nativeReference ? await this.rpc.balance?.(agent) ?? null : null;
    const wrapAmount = sell.nativeReference && balance < sellAmountUnits ? sellAmountUnits - balance : 0n;
    const prerequisiteTransactions: UnsignedTransaction[] = [];
    if (wrapAmount > 0n) prerequisiteTransactions.push({ chainId: this.manifest.chain.id, from: agent, to: sell.address, data: hexSchema.parse("0xd0e30db0"), value: quantityToHex(wrapAmount) });
    if (allowance < sellAmountUnits) prerequisiteTransactions.push({ chainId: this.manifest.chain.id, from: agent, to: sell.address, data: encodeApprove(this.manifest.contracts.permit2.address, sellAmountUnits), value: quantityToHex(0n) });
    checks.push({ name: "tokenCode", safe: true, codeHash: sell.codeHash });
    checks.push({ name: "agentBalance", safe: sell.nativeReference ? nativeBalance !== null && balance + nativeBalance >= sellAmountUnits : balance >= sellAmountUnits, tokenBalance: balance.toString(), nativeBalance: nativeBalance?.toString() ?? null });
    const criticalSafe = checks.every((check) => check["safe"] === true);
    const previewId = crypto.randomUUID(); const lifecycleNonce = randomHash();
    const disposition = request.policy.kind === "market" ? "immediate" : request.policy.kind === "limit" ? (calls.some((call) => call.to === this.manifest.contracts.aquaSwapRouter.address || call.to === this.manifest.contracts.limitSwapRouter.address) ? "immediate" : "resting") : "conditional";
    const unsigned = { previewId, expiresAt: expiresAt.toISOString(), owner: principal.address, agent, chainId: this.manifest.chain.id,
      normalizedTrade: { sellToken: sell.address, buyToken: buy.address, amount: request.amount, policy: request.policy, recipient: principal.address },
      tokens: { sell, buy }, spotPrice: { currency: this.quoter.defaultCurrency, sell: sell.spotPrice, buy: buy.spotPrice, observedAt: createdAt.toISOString(), provider: "1inch" },
      disposition, delegation: { required: true, token: sell.address, suggestedMaxPerOrder: request.amount.side === "sell" ? request.amount.value : null, suggestedMaxPerDay: request.amount.side === "sell" ? request.amount.value : null, suggestedExpiresAt: new Date(createdAt.getTime() + 86_400_000).toISOString() },
      prerequisites: { wrapRequired: wrapAmount > 0n, permit2ApprovalRequired: allowance < sellAmountUnits, transactions: prerequisiteTransactions },
      plan: prepared.body, calls,
      execution: { vault, deployment: { ...deployment }, action: { ...vaultPlan.action, amounts: vaultPlan.action.amounts.map(String), nonce: vaultPlan.action.nonce.toString(), deadline: vaultPlan.action.deadline.toString() }, fundingAmountUnits: sellAmountUnits.toString(), kind: vaultPlan.kind },
      lifecycle: { domain: typedDomain(this.manifest), primaryType: "VaultAction", types: { VaultAction: [{ name: "vault", type: "address" }, { name: "action", type: "uint8" }, { name: "strategyHash", type: "bytes32" }, { name: "tokensHash", type: "bytes32" }, { name: "amountsHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, message: { vault, action: vaultPlan.action.action, strategyHash: keccakHex(hexToBytes(vaultPlan.action.strategy)), tokensHash: hashAddressArray(vaultPlan.action.tokens), amountsHash: hashUint256Array(vaultPlan.action.amounts), nonce: vaultPlan.action.nonce.toString(), deadline: vaultPlan.action.deadline.toString() } },
      safety: { safe: criticalSafe, verdict: criticalSafe ? "simulatedWithFundedActivationCheck" : "unsafe", simulatedAt: createdAt.toISOString(), blockNumber: blockNumber.toString(), blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), checks, warnings: [...(sell.spotPrice === null || buy.spotPrice === null ? ["Fiat spot price unavailable; executable plan data remains authoritative"] : []), ...(checks.some((check) => check["deferredUntilFunded"] === true) ? ["The complete factory action is simulated again after exact vault funding and before broadcast"] : [])] },
    };
    const previewHash = digest(unsigned); const body = { ...unsigned, previewHash };
    await this.db`INSERT INTO trade_previews(id,preview_hash,owner,agent,state,request,response,lifecycle_nonce,expires_at,created_at) VALUES(${previewId},${previewHash},${principal.address},${agent},${criticalSafe ? "ready" : "unsafe"},${JSON.stringify(request)},${JSON.stringify(body)},${lifecycleNonce},${expiresAt},${createdAt})`;
    return { status: 201, body };
  }

  public async submit(input: { readonly previewId: string; readonly previewHash: Hash; readonly lifecycleSignature: Hex }, principal: AuthenticatedPrincipal, paymentHeader: string | null, prerequisiteTransactions: readonly Hash[]): Promise<TradeSubmissionResult> {
    const previews = await this.db<PreviewRow[]>`SELECT id,preview_hash,owner,agent,state,request,response,lifecycle_nonce,expires_at,submitted_at FROM trade_previews WHERE id=${input.previewId}`;
    const preview = previews[0];
    if (preview?.owner !== principal.address) throw new AppError(404, "urn:aqua:error:preview", "Trade preview was not found");
    if (preview.preview_hash !== input.previewHash) throw new AppError(409, "urn:aqua:error:preview-hash", "Trade preview hash does not match");
    if (preview.expires_at <= new Date()) throw new AppError(409, "urn:aqua:error:preview-expired", "Trade preview has expired; request a new preview");
    if (preview.state === "unsafe") throw new AppError(409, "urn:aqua:error:preview-unsafe", "Unsafe trade previews cannot be submitted");
    const operations = await this.db<OperationRow[]>`SELECT id,state,payment_transaction,deployment_transaction,lifecycle_transaction,action_payload,lifecycle_signature,prerequisite_transactions FROM agent_order_operations WHERE id=${input.previewId}`;
    const existing = operations[0];
    if (existing?.lifecycle_transaction !== null && existing?.lifecycle_transaction !== undefined) return { status: 200, body: this.submissionBody(existing.id, existing.state, existing.lifecycle_transaction, existing.payment_transaction, prerequisiteHashesSchema.parse(existing.prerequisite_transactions), existing.deployment_transaction) };
    if (existing?.lifecycle_signature !== null && existing?.lifecycle_signature !== undefined && existing.lifecycle_signature !== input.lifecycleSignature) throw new AppError(409, "urn:aqua:error:idempotency", "Idempotent retry changed the lifecycle signature");
    const lifecycle = typedDataSchema.parse(preview.response["lifecycle"]);
    const recovered = recoverTypedDataAddress(lifecycle, input.lifecycleSignature);
    if (recovered !== preview.agent) throw new AppError(401, "urn:aqua:error:lifecycle-signature", "Lifecycle signature was not made by the bound agent");
    const normalized = storedTradeSchema.parse(preview.response["normalizedTrade"]);
    const execution = storedExecutionSchema.parse(preview.response["execution"]);
    if (execution.deployment.owner !== preview.owner || execution.deployment.delegate !== preview.agent || execution.deployment.sellToken !== normalized.sellToken || execution.vault !== execution.action.vault) throw new AppError(409, "urn:aqua:error:execution-plan", "Stored vault execution plan is internally inconsistent");
    const atomicAmount = execution.fundingAmountUnits;
    const delegations = await this.db<DelegationRow[]>`SELECT max_per_order::text,max_per_day::text,spent_today::text,day_number::text,valid_until FROM delegation_projections WHERE owner=${preview.owner} AND agent=${preview.agent} AND token=${normalized.sellToken}`;
    const delegation = delegations[0]; const today = BigInt(Math.floor(Date.now() / 86_400_000));
    const spent = delegation === undefined || BigInt(delegation.day_number) !== today ? 0n : BigInt(delegation.spent_today);
    if (delegation === undefined || delegation.valid_until <= new Date() || BigInt(atomicAmount) > BigInt(delegation.max_per_order) || spent + BigInt(atomicAmount) > BigInt(delegation.max_per_day)) throw new AppError(409, "urn:aqua:error:delegation-required", "An active Ledger delegation with sufficient per-order and daily capacity is required");
    const vault = execution.vault;
    const requirement = exactPermit2UpfrontRequirement(this.manifest, { operationId: preview.id, sellToken: normalized.sellToken, vault, atomicAmount });
    if (existing?.payment_transaction !== null && existing?.payment_transaction !== undefined && existing.action_payload !== null) return this.activateFunded(existing, preview.owner, preview.agent, normalized.sellToken, input.lifecycleSignature);
    if (paymentHeader === null) return { status: 402, body: { error: "payment_required", previewId: preview.id, accepts: requirement.accepts }, paymentRequired: requirement };
    const payload = decodePaymentSignatureHeader(paymentHeader); const accepted = requirement.accepts[0];
    if (accepted === undefined) throw new Error("x402 requirement has no payment option");
    const verification = await this.facilitator.verify(payload, accepted);
    if (!verification.isValid || verification.payer?.toLowerCase() !== preview.agent) throw new AppError(402, "urn:aqua:error:x402-verification", verification.invalidMessage ?? "x402 payment payer or signature is invalid");
    const balanceBefore = decodeUint256(await this.rpc.call({ to: normalized.sellToken, data: encodeBalanceOf(vault) }));
    await this.recordSettlement(preview.id, preview.agent, payload, "settling", null, null);
    let settlement: SettleResponse;
    try { settlement = await this.facilitator.settle(payload, accepted); }
    catch (error: unknown) {
      await this.recordSettlement(preview.id, preview.agent, payload, "pending", null, error instanceof Error ? error.message : "settlement indeterminate");
      return { status: 202, body: { tradeId: preview.id, operationId: paymentIdentifier(preview.id), status: "fundedActivationPending", tradeTransactionHash: null, fundingTransactionHash: null, prerequisiteTransactionHashes: prerequisiteTransactions } };
    }
    if (!settlement.success) throw new AppError(402, "urn:aqua:error:x402-settlement", settlement.errorMessage ?? settlement.errorReason ?? "x402 settlement failed");
    const fundingHash = hashSchema.parse(settlement.transaction);
    const balanceAfter = decodeUint256(await this.rpc.call({ to: normalized.sellToken, data: encodeBalanceOf(vault) }));
    if (balanceAfter - balanceBefore !== BigInt(atomicAmount)) {
      await this.recordSettlement(preview.id, preview.agent, payload, "failed", fundingHash, "settlement balance delta was not exact");
      throw new AppError(409, "urn:aqua:error:token-balance-delta", "Funded token changed the vault balance by a non-exact amount; activation is blocked and the Ledger owner can recover deployed-vault funds");
    }
    await this.recordSettlement(preview.id, preview.agent, payload, "settled", fundingHash, null);
    await this.db`INSERT INTO agent_order_operations(id,owner,agent,vault,sell_token,buy_token,sell_amount,funded_amount,state,lifecycle_nonce,payment_identifier,payment_transaction,action_payload,lifecycle_signature,prerequisite_transactions,created_at,updated_at) VALUES(${preview.id},${preview.owner},${preview.agent},${vault},${normalized.sellToken},${normalized.buyToken},${atomicAmount},${atomicAmount},'fundedActivationPending',${execution.action.nonce},${paymentIdentifier(preview.id)},${fundingHash},${JSON.stringify(execution)},${input.lifecycleSignature},${JSON.stringify(prerequisiteTransactions)},now(),now()) ON CONFLICT(id) DO UPDATE SET funded_amount=EXCLUDED.funded_amount,state='fundedActivationPending',payment_transaction=EXCLUDED.payment_transaction,action_payload=EXCLUDED.action_payload,lifecycle_signature=EXCLUDED.lifecycle_signature,prerequisite_transactions=EXCLUDED.prerequisite_transactions,updated_at=now()`;
    await this.db`UPDATE trade_previews SET state='submitted',submitted_at=now() WHERE id=${preview.id} AND state='ready'`;
    const stored: OperationRow = { id: preview.id, state: "fundedActivationPending", payment_transaction: fundingHash, deployment_transaction: null, lifecycle_transaction: null, action_payload: execution, lifecycle_signature: input.lifecycleSignature, prerequisite_transactions: prerequisiteTransactions };
    const activated = await this.activateFunded(stored, preview.owner, preview.agent, normalized.sellToken, input.lifecycleSignature);
    return { ...activated, paymentResponse: settlement };
  }

  private async activateFunded(operation: OperationRow, owner: Address, agent: Address, sellToken: Address, signature: Hex): Promise<TradeSubmissionResult> {
    const execution = storedExecutionSchema.parse(operation.action_payload);
    const prerequisiteTransactions = prerequisiteHashesSchema.parse(operation.prerequisite_transactions);
    let deploymentHash = operation.deployment_transaction;
    try {
      if (await this.rpc.getCode(execution.vault) === "0x") {
        deploymentHash = await this.relay.relay({ to: this.manifest.contracts.orderVaultFactory.address, data: encodeDeployVault(execution.deployment) });
        await this.db`UPDATE agent_order_operations SET deployment_transaction=${deploymentHash},updated_at=now() WHERE id=${operation.id}`;
        const receipt = await this.waitForReceipt(deploymentHash, 30_000);
        if (receipt === null) return { status: 202, body: this.submissionBody(operation.id, "fundedActivationPending", null, operation.payment_transaction, prerequisiteTransactions, deploymentHash) };
        if (receipt.status !== "success") throw new Error("Vault deployment reverted");
      }
      const balance = decodeUint256(await this.rpc.call({ to: sellToken, data: encodeBalanceOf(execution.vault) }));
      if (balance < BigInt(execution.fundingAmountUnits)) throw new Error("Vault funding is below the reviewed amount");
      const action = storedVaultAction(execution.action);
      const call = { to: this.manifest.contracts.orderVaultFactory.address, data: encodeExecuteVaultAction(action, signature) } as const;
      await Promise.all([this.rpc.call(call), this.rpc.estimateGas(call)]);
      const tradeHash = await this.relay.relay(call);
      await this.db.begin(async (transaction) => {
        await transaction`UPDATE agent_order_operations SET state='broadcast',lifecycle_transaction=${tradeHash},updated_at=now() WHERE id=${operation.id} AND lifecycle_transaction IS NULL`;
        await transaction`UPDATE delegation_projections SET spent_today=CASE WHEN day_number=${String(Math.floor(Date.now()/86_400_000))} THEN spent_today+${execution.fundingAmountUnits} ELSE ${execution.fundingAmountUnits} END,day_number=${String(Math.floor(Date.now()/86_400_000))},updated_at=now() WHERE owner=${owner} AND agent=${agent} AND token=${sellToken}`;
      });
      return { status: 200, body: this.submissionBody(operation.id, "broadcast", tradeHash, operation.payment_transaction, prerequisiteTransactions, deploymentHash) };
    } catch (error: unknown) {
      await this.db`UPDATE agent_order_operations SET state='fundedActivationPending',updated_at=now() WHERE id=${operation.id}`;
      return { status: 202, body: { ...this.submissionBody(operation.id, "fundedActivationPending", null, operation.payment_transaction, prerequisiteTransactions, deploymentHash), operationId: paymentIdentifier(operation.id), activationError: error instanceof Error ? error.message : "activation interrupted" } };
    }
  }

  private async waitForReceipt(hash: Hash, timeoutMs: number): Promise<Awaited<ReturnType<RpcPort["transactionReceipt"]>>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const receipt = await this.rpc.transactionReceipt(hash); if (receipt !== null) return receipt; await Bun.sleep(250); }
    return null;
  }

  private async recordSettlement(previewId: string, payer: Address, payload: unknown, state: string, transactionHash: Hash | null, error: string | null): Promise<void> {
    await this.db`INSERT INTO x402_settlements(payment_identifier,preview_id,payer,state,payload,transaction_hash,error,updated_at) VALUES(${paymentIdentifier(previewId)},${previewId},${payer},${state},${JSON.stringify(payload)},${transactionHash},${error},now()) ON CONFLICT(payment_identifier) DO UPDATE SET state=EXCLUDED.state,payload=EXCLUDED.payload,transaction_hash=COALESCE(EXCLUDED.transaction_hash,x402_settlements.transaction_hash),error=EXCLUDED.error,updated_at=now()`;
  }

  private submissionBody(id: string, status: string, tradeHash: Hash | null, fundingHash: Hash | null, prerequisiteTransactions: readonly Hash[], deploymentHash: Hash | null = null): Readonly<Record<string, unknown>> { return { tradeId: id, status, tradeTransactionHash: tradeHash, fundingTransactionHash: fundingHash, prerequisiteTransactionHashes: deploymentHash === null ? prerequisiteTransactions : [...prerequisiteTransactions, deploymentHash] }; }

  public async listTrades(query: TradesListQuery, owner: Address) {
    const cursorSchema = z.object({ at: z.iso.datetime({ offset: true }), id: z.string().min(1) }).strict();
    const cursor = query.cursor === undefined ? null : cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    const ownRows = query.source !== "subscriptions" ? await this.db<OwnTradeRow[]>`SELECT o.id,o.state AS status,o.owner,o.agent,o.sell_token,o.buy_token,o.sell_amount::text,o.funded_amount::text,o.payment_transaction,o.lifecycle_transaction,p.request->'policy'->>'kind' AS kind,o.created_at AS occurred_at,o.updated_at FROM agent_order_operations o JOIN trade_previews p ON p.id=o.id WHERE o.owner=${owner} LIMIT 1000` : [];
    const subscribedRows = query.source !== "own" ? await this.db<SubscribedTradeRow[]>`SELECT id,watched_address,transaction_hash,sell_token,buy_token,sell_amount::text,buy_amount::text,occurred_at,updated_at FROM subscribed_trades WHERE owner=${owner} LIMIT 1000` : [];
    const own = ownRows.map((row) => ({ recordType: "aqua" as const, id: row.id, status: row.status, owner: row.owner, agent: row.agent, sellToken: row.sell_token, buyToken: row.buy_token, sellAmountUnits: row.sell_amount, fundedAmountUnits: row.funded_amount, paymentTransactionHash: row.payment_transaction, lifecycleTransactionHash: row.lifecycle_transaction, kind: row.kind, occurredAt: row.occurred_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
    const subscribed = subscribedRows.map((row) => ({ recordType: "subscribed" as const, id: row.id, status: "confirmed", watchedAddress: row.watched_address, transactionHash: row.transaction_hash, sellToken: row.sell_token, buyToken: row.buy_token, sellAmountUnits: row.sell_amount, buyAmountUnits: row.buy_amount, kind: "swap", occurredAt: row.occurred_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
    const selected = [...own, ...subscribed].filter((item) => query.status === undefined || item.status === query.status)
      .filter((item) => query.address === undefined || (item.recordType === "aqua" ? item.owner === query.address || item.agent === query.address : item.watchedAddress === query.address))
      .filter((item) => query.token === undefined || item.sellToken === query.token || item.buyToken === query.token)
      .filter((item) => query.kind === undefined || item.kind === query.kind)
      .filter((item) => query.from === undefined || item.occurredAt >= query.from).filter((item) => query.to === undefined || item.occurredAt < query.to);
    const key = query.sort === "occurredAt" ? "occurredAt" : "updatedAt";
    selected.sort((left, right) => { const order = left[key].localeCompare(right[key]) || left.id.localeCompare(right.id); return query.direction === "asc" ? order : -order; });
    const afterCursor = cursor === null ? selected : selected.filter((item) => { const order = item[key].localeCompare(cursor.at) || item.id.localeCompare(cursor.id); return query.direction === "asc" ? order > 0 : order < 0; });
    const items = afterCursor.slice(0, query.limit); const last = items.at(-1);
    const nextCursor = afterCursor.length > query.limit && last !== undefined ? Buffer.from(JSON.stringify({ at: last[key], id: last.id })).toString("base64url") : null;
    return { items, nextCursor };
  }

  public async wipeSubscribed(input: SubscribedTradesWipe, owner: Address): Promise<{ readonly deletedCount: string }> {
    const result: unknown = input.scope === "all" ? await this.db`DELETE FROM subscribed_trades WHERE owner=${owner}` : await this.db`DELETE FROM subscribed_trades WHERE owner=${owner} AND watched_address=${input.address}`;
    const count = typeof result === "object" && result !== null && "count" in result && (typeof result.count === "number" || typeof result.count === "bigint") ? BigInt(result.count) : 0n;
    return { deletedCount: count.toString() };
  }
}

const zTransaction = z.object({
  to: addressSchema, data: hexSchema, value: quantitySchema,
  from: addressSchema, chainId: z.number().int().positive(), gas: quantitySchema.optional(),
}).strict();
const decimalIntegerSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const prerequisiteHashesSchema = z.array(hashSchema).max(2);
const preparedEnvelopeSchema = z.object({ result: z.unknown() }).loose();
const restingPlanSchema = z.object({
  encodedOrder: hexSchema,
  normalizedOrder: z.object({ sellAmountUnits: decimalIntegerSchema }).loose(),
}).loose();
const immediateRouteSchema = z.object({
  transaction: z.object({ to: addressSchema, data: hexSchema }).loose(),
  requiredInputUnits: decimalIntegerSchema,
  minimumOutputUnits: decimalIntegerSchema,
}).loose();
const immediatePlanSchema = z.object({ orderedPlans: z.array(immediateRouteSchema).min(1).max(8) }).loose();
const storedDeploymentSchema = z.object({
  owner: addressSchema, delegate: addressSchema, aqua: addressSchema, app: addressSchema,
  sellToken: addressSchema, salt: hashSchema,
}).strict();
const storedActionSchema = z.object({
  vault: addressSchema, action: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  strategy: hexSchema, tokens: z.array(addressSchema).min(1).max(8), amounts: z.array(decimalIntegerSchema).min(1).max(8),
  nonce: decimalIntegerSchema, deadline: decimalIntegerSchema,
}).strict();
const storedExecutionSchema = z.object({
  vault: addressSchema, deployment: storedDeploymentSchema, action: storedActionSchema,
  fundingAmountUnits: decimalIntegerSchema, kind: z.enum(["market", "resting"]),
}).strict();
const typedDataSchema = z.custom<Eip712TypedData>((value) => typeof value === "object" && value !== null && "domain" in value && "types" in value && "primaryType" in value && "message" in value);
const storedVaultAction = (value: z.infer<typeof storedActionSchema>): VaultAction => ({
  vault: value.vault, action: value.action, strategy: value.strategy, tokens: value.tokens,
  amounts: value.amounts.map(BigInt), nonce: BigInt(value.nonce), deadline: BigInt(value.deadline),
});
