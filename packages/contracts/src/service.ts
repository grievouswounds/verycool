import { AppError, formatTokenAmount, hexSchema, parseTokenAmount, positiveAmountSchema, validationError } from "@aqua/core";
import type {
  Address, AuthenticatedPrincipal, DirectSwapRequest, Hash, Hex,
  LimitOrderCancellation, LimitOrderRequest, NativeAmount, Quote, RpcPort, UnsignedTransaction,
} from "@aqua/core";
import {
  decodeOrder, decodeQuoteResult, decodeUint256, encodeAllowance, encodeApprove, encodeDock,
  encodeOrder, encodeShip, encodeSwapVmCall, encodeWithdraw, orderHash, quantityToHex, selector,
} from "@aqua/evm";
import type { QuoteResult, SwapVmOrder } from "@aqua/evm";
import { AQUA_MAKER_TRAITS, encodeTakerTraits } from "./traits.ts";
import { assertAllowedProgram, buildLimitProgram, decodeProgram } from "./program.ts";

export interface ProtocolConfiguration {
  readonly chainId: number;
  readonly aqua: Address;
  readonly aquaSwapRouter: Address;
  readonly limitSwapRouter: Address;
  readonly wrappedNativeToken: Address;
}

export interface DirectSwapResult {
  readonly chainId: number;
  readonly orderHash: Hash;
  readonly quote: Quote;
  readonly transaction: UnsignedTransaction;
  readonly approval?: UnsignedTransaction;
  readonly preTransactions: readonly UnsignedTransaction[];
  readonly tokenDecimals: { readonly tokenIn: number; readonly tokenOut: number };
  readonly requiredInputUnits: string;
  readonly minimumOutputUnits: string;
}

export interface DirectQuoteResult {
  readonly chainId: number;
  readonly orderHash: Hash;
  readonly quote: Quote;
  readonly tokenDecimals: { readonly tokenIn: number; readonly tokenOut: number };
}

export interface LimitOrderResult {
  readonly chainId: number;
  readonly encodedOrder: Hex;
  readonly orderHash: Hash;
  readonly program: Hex;
  readonly instructions: ReturnType<typeof decodeProgram>;
  readonly shipTransaction: UnsignedTransaction;
  readonly dockTransaction: UnsignedTransaction;
  readonly approval?: UnsignedTransaction;
  readonly normalizedOrder: {
    readonly sellAmount: string;
    readonly buyAmount: string;
    readonly sellAmountUnits: string;
    readonly buyAmountUnits: string;
    readonly sellTokenDecimals: number;
    readonly buyTokenDecimals: number;
    readonly timeInForce: "GTC" | "GTD" | "IOC" | "FOK";
    readonly fillPolicy: "partial" | "allOrNothing";
    readonly nonce: number | null;
    readonly expiresAt: string | null;
    readonly salt: Hex;
  };
}

export interface TransactionResult { readonly chainId: number; readonly transaction: UnsignedTransaction }

const tx = (
  config: ProtocolConfiguration, from: Address, to: Address, data: Hex, value = 0n, gas?: bigint,
): UnsignedTransaction => ({
  chainId: config.chainId, from, to, data, value: quantityToHex(value),
  ...(gas === undefined ? {} : { gas: quantityToHex(gas) }),
});

const quotedAmount = (value: bigint, decimals: number, label: string) => {
  const formatted = formatTokenAmount(value, decimals);
  if (!/[1-9]/u.test(formatted)) throw new AppError(409, "urn:aqua:error:no-liquidity", `SwapVM quote returned a non-positive ${label}`);
  return positiveAmountSchema.parse(formatted);
};
const seconds = (iso: string): bigint => BigInt(Math.floor(new Date(iso).getTime() / 1_000));
const MAX_UINT40 = (1n << 40n) - 1n;

const randomSalt = (): Hex => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return hexSchema.parse(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
};

const randomNonce = (): number => {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  if (value === undefined) throw new Error("Secure nonce generation failed");
  return value;
};

export class ProtocolService {
  private readonly config: ProtocolConfiguration;
  private readonly rpc: RpcPort;
  private readonly now: () => Date;

  public constructor(
    config: ProtocolConfiguration,
    rpc: RpcPort,
    now: () => Date = () => new Date(),
  ) {
    this.config = config;
    this.rpc = rpc;
    this.now = now;
  }

  private async directQuoteContext(input: DirectSwapRequest, taker: Address) {
    const now = seconds(this.now().toISOString());
    const deadline = input.deadline === undefined ? now + BigInt(input.lifetimeSeconds ?? 300) : seconds(input.deadline);
    if (deadline <= now) throw validationError("deadline must be in the future");
    if (input.receiveNative && input.tokenOut !== this.config.wrappedNativeToken) {
      throw validationError("receiveNative requires tokenOut to be the configured wrapped-native token");
    }
    const order = decodeOrder(input.encodedOrder);
    if ((order.traits & AQUA_MAKER_TRAITS) === 0n) throw validationError("Only Aqua-authenticated orders are accepted");
    assertAllowedProgram(order.data, input.routerKind);
    const router = input.routerKind === "aquaLimit" ? this.config.limitSwapRouter : this.config.aquaSwapRouter;
    const [tokenInDecimals, tokenOutDecimals] = await Promise.all([
      this.rpc.tokenDecimals(input.tokenIn), this.rpc.tokenDecimals(input.tokenOut),
    ]);
    const exactIn = input.amountIn !== undefined;
    const requested = exactIn
      ? parseTokenAmount(input.amountIn ?? "", tokenInDecimals)
      : parseTokenAmount(input.amountOut ?? "", tokenOutDecimals);
    const recipient = input.recipient === undefined ? {} : { recipient: input.recipient };
    const quoteTraits = encodeTakerTraits({
      exactIn, shouldUnwrap: input.receiveNative,
      threshold: 0n, taker, deadlineSeconds: deadline, ...recipient,
    });
    const quoteData = encodeSwapVmCall("quote", order, input.tokenIn, input.tokenOut, requested, quoteTraits);
    let quoted: QuoteResult;
    try {
      quoted = decodeQuoteResult(await this.rpc.call({ from: taker, to: router, data: quoteData }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "quote reverted";
      throw new AppError(502, "urn:aqua:error:upstream", `SwapVM quote reverted: ${message}`);
    }
    return { deadline, exactIn, order, quoted, recipient, requested, router, tokenInDecimals, tokenOutDecimals };
  }

  public async quoteDirect(input: DirectSwapRequest, taker: Address): Promise<DirectQuoteResult> {
    const context = await this.directQuoteContext(input, taker);
    return {
      chainId: this.config.chainId,
      orderHash: context.quoted.orderHash,
      quote: {
        amountIn: quotedAmount(context.quoted.amountIn, context.tokenInDecimals, "amountIn"),
        amountOut: quotedAmount(context.quoted.amountOut, context.tokenOutDecimals, "amountOut"),
        orderHash: context.quoted.orderHash,
      },
      tokenDecimals: { tokenIn: context.tokenInDecimals, tokenOut: context.tokenOutDecimals },
    };
  }

  public async prepareDirect(input: DirectSwapRequest, principal: AuthenticatedPrincipal): Promise<DirectSwapResult> {
    if (input.payWithNative && input.tokenIn !== this.config.wrappedNativeToken) {
      throw validationError("payWithNative requires tokenIn to be the configured wrapped-native token");
    }
    const context = await this.directQuoteContext(input, principal.address);
    const bps = BigInt(input.slippageBps);
    const threshold = context.exactIn
      ? context.quoted.amountOut * (10_000n - bps) / 10_000n
      : (context.quoted.amountIn * (10_000n + bps) + 9_999n) / 10_000n;
    const finalTraits = encodeTakerTraits({
      exactIn: context.exactIn, shouldUnwrap: input.receiveNative,
      threshold, taker: principal.address, deadlineSeconds: context.deadline, ...context.recipient,
    });
    const data = encodeSwapVmCall("swap", context.order, input.tokenIn, input.tokenOut, context.requested, finalTraits);
    const value = 0n;
    let gas: bigint | undefined;
    try { gas = await this.rpc.estimateGas({ from: principal.address, to: context.router, data, value: quantityToHex(value) }); }
    catch { gas = undefined; }
    const requiredInput = context.exactIn ? context.requested : threshold;
    const allowance = decodeUint256(await this.rpc.call({
      from: principal.address, to: input.tokenIn, data: encodeAllowance(principal.address, context.router),
    }));
    const approval = allowance < requiredInput
      ? tx(this.config, principal.address, input.tokenIn, encodeApprove(context.router, requiredInput))
      : undefined;
    const preTransactions = input.payWithNative
      ? [tx(this.config, principal.address, this.config.wrappedNativeToken, selector("deposit()"), requiredInput)]
      : [];
    return {
      chainId: this.config.chainId, orderHash: context.quoted.orderHash,
      quote: {
        amountIn: quotedAmount(context.quoted.amountIn, context.tokenInDecimals, "amountIn"),
        amountOut: quotedAmount(context.quoted.amountOut, context.tokenOutDecimals, "amountOut"),
        orderHash: context.quoted.orderHash,
      },
      transaction: tx(this.config, principal.address, context.router, data, value, gas),
      ...(approval === undefined ? {} : { approval }), preTransactions,
      tokenDecimals: { tokenIn: context.tokenInDecimals, tokenOut: context.tokenOutDecimals },
      requiredInputUnits: requiredInput.toString(10),
      minimumOutputUnits: (context.exactIn ? threshold : context.requested).toString(10),
    };
  }

  public async prepareLimit(input: LimitOrderRequest, principal: AuthenticatedPrincipal): Promise<LimitOrderResult> {
    const now = seconds(this.now().toISOString());
    const shortLived = input.timeInForce === "IOC" || input.timeInForce === "FOK";
    const expiry = input.expiresAt !== undefined
      ? seconds(input.expiresAt)
      : input.lifetimeSeconds !== undefined
        ? now + BigInt(input.lifetimeSeconds)
        : shortLived ? now + 60n : MAX_UINT40;
    if (expiry <= now) throw validationError("expiresAt must be in the future");
    const [sellDecimals, buyDecimals] = await Promise.all([
      this.rpc.tokenDecimals(input.sellToken), this.rpc.tokenDecimals(input.buyToken),
    ]);
    const sellAmount = parseTokenAmount(input.sellAmount, sellDecimals);
    const buyAmount = parseTokenAmount(input.buyAmount, buyDecimals);
    const fullFill = input.fillPolicy === "allOrNothing" || input.timeInForce === "FOK";
    const generatedNonce = fullFill ? input.nonce ?? randomNonce() : undefined;
    const salt = input.salt ?? randomSalt();
    const program = buildLimitProgram({
      sellToken: input.sellToken, buyToken: input.buyToken,
      sellAmount, buyAmount,
      expiresAtSeconds: expiry, salt,
      fill: fullFill ? { type: "allOrNothing", nonce: generatedNonce ?? randomNonce() } : { type: "partial" },
    });
    const order: SwapVmOrder = { maker: principal.address, traits: AQUA_MAKER_TRAITS, data: program };
    const encodedOrder = encodeOrder(order);
    const hash = orderHash(order);
    const tokens: readonly [Address, Address] = [input.buyToken, input.sellToken];
    const amounts: readonly [bigint, bigint] = [buyAmount, sellAmount];
    const allowance = decodeUint256(await this.rpc.call({
      from: principal.address, to: input.sellToken, data: encodeAllowance(principal.address, this.config.aqua),
    }));
    const required = sellAmount;
    const approval = allowance < required
      ? tx(this.config, principal.address, input.sellToken, encodeApprove(this.config.aqua, required))
      : undefined;
    return {
      chainId: this.config.chainId, encodedOrder, orderHash: hash, program,
      instructions: decodeProgram(program),
      shipTransaction: tx(this.config, principal.address, this.config.aqua,
        encodeShip(this.config.limitSwapRouter, encodedOrder, tokens, amounts)),
      dockTransaction: tx(this.config, principal.address, this.config.aqua,
        encodeDock(this.config.limitSwapRouter, hash, tokens)),
      ...(approval === undefined ? {} : { approval }),
      normalizedOrder: {
        sellAmount: input.sellAmount, buyAmount: input.buyAmount,
        sellAmountUnits: sellAmount.toString(10), buyAmountUnits: buyAmount.toString(10),
        sellTokenDecimals: sellDecimals, buyTokenDecimals: buyDecimals,
        timeInForce: input.timeInForce, fillPolicy: fullFill ? "allOrNothing" : "partial",
        nonce: generatedNonce ?? null,
        expiresAt: input.timeInForce === "GTC" ? null : new Date(Number(expiry) * 1_000).toISOString(), salt,
      },
    };
  }

  public prepareLimitCancellation(input: LimitOrderCancellation, principal: AuthenticatedPrincipal): TransactionResult {
    return {
      chainId: this.config.chainId,
      transaction: tx(this.config, principal.address, this.config.aqua,
        encodeDock(this.config.limitSwapRouter, input.orderHash, [input.buyToken, input.sellToken])),
    };
  }

  public async prepareNative(kind: "wrap" | "unwrap", input: NativeAmount, principal: AuthenticatedPrincipal): Promise<TransactionResult> {
    const amount = parseTokenAmount(input.amount, await this.rpc.tokenDecimals(this.config.wrappedNativeToken));
    return {
      chainId: this.config.chainId,
      transaction: kind === "wrap"
        ? tx(this.config, principal.address, this.config.wrappedNativeToken, selector("deposit()"), amount)
        : tx(this.config, principal.address, this.config.wrappedNativeToken, encodeWithdraw(amount)),
    };
  }
}
