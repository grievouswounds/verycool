import {
  ABI,
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  Address,
  HexString,
  Order,
  SwapVMContract,
  TakerTraits,
} from "@1inch/swap-vm-sdk";
import { createPublicClient, decodeFunctionResult, http, type Address as ViemAddress, type Hex } from "viem";
import { getRpcUrl } from "./config";
import { ApiError, AquaQuoteRequest, AquaQuoteResult } from "./types";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function validateAddress(value: string, label: string): asserts value is ViemAddress {
  if (!ADDRESS_REGEX.test(value)) throw new ApiError(400, `Invalid ${label}: ${value}`);
}

function parseAmount(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, "amountIn must be a positive integer in token base units");
  }
  return BigInt(value);
}

/**
 * Calls AquaSwapVM.quote via eth_call. This does not need a private key and
 * cannot broadcast a transaction. The quote is for one concrete Aqua order;
 * callers discover candidate orders separately and can compare their outputs.
 */
export async function quoteAquaOrder(request: AquaQuoteRequest): Promise<AquaQuoteResult> {
  const { chainId, encodedOrder, tokenIn, tokenOut, amountIn, taker } = request;
  if (!Number.isInteger(chainId) || chainId <= 0) throw new ApiError(400, "Invalid chainId");
  validateAddress(tokenIn, "tokenIn address");
  validateAddress(tokenOut, "tokenOut address");
  validateAddress(taker, "taker address");
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) throw new ApiError(400, "tokenIn and tokenOut must differ");

  const routerAddress = (AQUA_SWAP_VM_CONTRACT_ADDRESSES as Record<number, Address>)[chainId];
  if (!routerAddress) throw new ApiError(400, `Aqua SwapVM is not configured for chain ${chainId}`);

  let order: Order;
  try {
    order = Order.decode(new HexString(encodedOrder));
  } catch {
    throw new ApiError(400, "encodedOrder is not a valid Aqua SwapVM order");
  }

  const quoteTx = new SwapVMContract(routerAddress).quote({
    order,
    tokenIn: new Address(tokenIn),
    tokenOut: new Address(tokenOut),
    amount: parseAmount(amountIn),
    takerTraits: TakerTraits.default(),
  });

  try {
    const response = await createPublicClient({ transport: http(getRpcUrl()) }).call({
      account: taker,
      to: quoteTx.to as ViemAddress,
      data: quoteTx.data as Hex,
      value: quoteTx.value,
    });
    if (!response.data) throw new ApiError(422, "Aqua quote returned no data");
    const [quotedAmountIn, quotedAmountOut] = decodeFunctionResult({
      abi: ABI.SWAP_VM_ABI,
      functionName: "quote",
      data: response.data,
    });
    return {
      amountIn: quotedAmountIn.toString(),
      amountOut: quotedAmountOut.toString(),
      tokenIn,
      tokenOut,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error
      ? (error as Error & { shortMessage?: string }).shortMessage ?? error.message
      : "Unknown RPC error";
    throw new ApiError(422, `Aqua quote failed: ${message}`);
  }
}
