import { addressSchema, AppError } from "@aqua/core";
import type { Address, DirectSwapRequest } from "@aqua/core";
import type { DirectQuoteResult, ProtocolService } from "@aqua/contracts";
import type { AquaQuoteRequest } from "./schemas.ts";
import type { OneInchPriceClient } from "./one-inch.ts";

export interface QuoterServiceConfiguration {
  readonly chainId: number;
  readonly defaultCurrency: string;
  readonly priceClient: OneInchPriceClient | null;
  readonly protocol: Pick<ProtocolService, "quoteDirect">;
}

export class QuoterService {
  private readonly chainId: number;
  private readonly defaultCurrencyValue: string;
  private readonly priceClient: OneInchPriceClient | null;
  private readonly protocol: Pick<ProtocolService, "quoteDirect">;

  public constructor(configuration: QuoterServiceConfiguration) {
    this.chainId = configuration.chainId;
    this.defaultCurrencyValue = configuration.defaultCurrency;
    this.priceClient = configuration.priceClient;
    this.protocol = configuration.protocol;
  }

  public get defaultCurrency(): string { return this.defaultCurrencyValue; }
  public get pricesAvailable(): boolean { return this.priceClient !== null; }

  private prices(): OneInchPriceClient {
    if (this.priceClient === null) {
      throw new AppError(503, "urn:aqua:error:price-unavailable", "Price lookup is disabled because ONEINCH_API_KEY is not configured");
    }
    return this.priceClient;
  }

  public async priceByAddress(address: Address, currency: string) {
    return { chainId: String(this.chainId), address, currency, price: await this.prices().price(this.chainId, address, currency) };
  }

  public async priceByName(name: string, currency: string) {
    const token = await this.prices().search(this.chainId, name);
    const address = addressSchema.safeParse(token.address);
    if (!address.success) throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream returned an invalid token address");
    const price = await this.prices().price(this.chainId, address.data, currency);
    return { chainId: String(this.chainId), address: address.data, symbol: token.symbol, name: token.name, decimals: String(token.decimals), currency, price };
  }

  public quote(request: AquaQuoteRequest, taker: Address): Promise<DirectQuoteResult> {
    const input: DirectSwapRequest = {
      routerKind: request.routerKind, encodedOrder: request.encodedOrder,
      tokenIn: request.tokenIn, tokenOut: request.tokenOut,
      ...(request.amountIn === undefined ? {} : { amountIn: request.amountIn }),
      ...(request.amountOut === undefined ? {} : { amountOut: request.amountOut }),
      slippageBps: 50,
      ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
      ...(request.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: request.lifetimeSeconds }),
      ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
      payWithNative: false, receiveNative: request.receiveNative,
    };
    return this.protocol.quoteDirect(input, taker);
  }
}
