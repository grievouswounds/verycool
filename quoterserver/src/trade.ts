import {
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  ABI,
  Address,
  HexString,
  Order,
  SwapVMContract,
  TakerTraits,
} from "@1inch/swap-vm-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, decodeFunctionResult, http, type Address as ViemAddress, type Hex } from "viem";
import { getTradeConfig } from "./config";
import { ApiError, TradeRequest, TradeResult } from "./types";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function assertAddress(value: string, label: string): asserts value is ViemAddress {
  if (!ADDRESS_REGEX.test(value)) throw new ApiError(400, `Invalid ${label}: ${value}`);
}

function parseBaseUnits(value: string, label: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, `${label} must be a positive integer in token base units`);
  }
  return BigInt(value);
}

/**
 * Simulates then submits an exact-input Aqua SwapVM order through this server's
 * configured wallet. The wallet must already have any necessary token approval
 * and balance; no approval transaction is made implicitly.
 */
export async function executeAquaTrade(request: TradeRequest): Promise<TradeResult> {
  const { chainId, encodedOrder, tokenIn, tokenOut, amountIn, minAmountOut } = request;
  if (!Number.isInteger(chainId) || chainId <= 0) throw new ApiError(400, "Invalid chainId");
  assertAddress(tokenIn, "tokenIn address");
  assertAddress(tokenOut, "tokenOut address");
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) throw new ApiError(400, "tokenIn and tokenOut must differ");

  const inputAmount = parseBaseUnits(amountIn, "amountIn");
  const minimumOutput = parseBaseUnits(minAmountOut, "minAmountOut");
  const routerAddress = (AQUA_SWAP_VM_CONTRACT_ADDRESSES as Record<number, Address>)[chainId];
  if (!routerAddress) throw new ApiError(400, `Aqua SwapVM is not configured for chain ${chainId}`);

  const { rpcUrl, privateKey } = getTradeConfig();
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  let order: Order;
  try {
    order = Order.decode(new HexString(encodedOrder));
  } catch {
    throw new ApiError(400, "encodedOrder is not a valid Aqua SwapVM order");
  }

  const swapVm = new SwapVMContract(routerAddress);
  const swapParams = {
    order,
    tokenIn: new Address(tokenIn),
    tokenOut: new Address(tokenOut),
    amount: inputAmount,
    takerTraits: TakerTraits.default().with({ threshold: minimumOutput }),
  };
  const quoteTx = swapVm.quote(swapParams);
  const tx = swapVm.swap(swapParams);

  try {
    // A preflight call catches an invalid order, insufficient approval, and
    // slippage failure before a transaction is broadcast.
    const quoteResponse = await publicClient.call({
      account: account.address,
      to: quoteTx.to as ViemAddress,
      data: quoteTx.data as Hex,
      value: quoteTx.value,
    });
    if (!quoteResponse.data) throw new ApiError(422, "Aqua quote returned no data");
    const [, quotedAmountOut] = decodeFunctionResult({
      abi: ABI.SWAP_VM_ABI,
      functionName: "quote",
      data: quoteResponse.data,
    });
    if (quotedAmountOut < minimumOutput) {
      throw new ApiError(422, "Quoted output is below minAmountOut");
    }
    await publicClient.call({ account: account.address, to: tx.to as ViemAddress, data: tx.data as Hex, value: tx.value });
    const transactionHash = await walletClient.sendTransaction({
      account,
      chain: undefined,
      to: tx.to as ViemAddress,
      data: tx.data as Hex,
      value: tx.value,
    });
    return {
      transactionHash,
      quotedAmountIn: inputAmount.toString(),
      quotedAmountOut: quotedAmountOut.toString(),
      minAmountOut: minimumOutput.toString(),
    };
  } catch (error) {
    const message = error instanceof Error
      ? (error as Error & { shortMessage?: string }).shortMessage ?? error.message
      : "Unknown RPC error";
    throw new ApiError(422, `Aqua trade simulation or submission failed: ${message}`);
  }
}
