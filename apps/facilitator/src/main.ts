import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { addressSchema, hashSchema, hexSchema, loadRuntimeManifest, localProfileDefaults } from "@aqua/core";
import type { Hex } from "@aqua/core";
import {
  concatHex, decodeAddress, decodeUint256, encodeAllowance, encodeBalanceOf, encodeIsValidSignature,
  encodeX402ExactSettle, encodeX402ExactSettleWithPermit, JsonRpcClient, recoverTypedDataAddress, selector,
} from "@aqua/evm";
import type { Eip712TypedData } from "@aqua/evm";
import { SecretBrokerClient } from "@aqua/security";
import { z } from "zod";

const manifest = await loadRuntimeManifest(Bun.argv);
const broker = new SecretBrokerClient(manifest.services.brokerSocket);
const identity = await broker.identity();
const rpc = new JsonRpcClient(new URL(manifest.chain.rpcUrl), localProfileDefaults.rpcTimeoutMs);
type WireHex = `0x${string}`;
const wireHexSchema = z.custom<WireHex>((value) => typeof value === "string" && /^0x[0-9a-fA-F]*$/u.test(value));

const permitSchema = z.object({
  permitted: z.object({ token: addressSchema, amount: z.bigint() }).strict(),
  nonce: z.bigint(), deadline: z.bigint(),
}).strict();
const witnessSchema = z.object({ to: addressSchema, validAfter: z.bigint() }).strict();
const eip2612Schema = z.object({
  value: z.bigint(), deadline: z.bigint(), r: hashSchema, s: hashSchema, v: z.number().int().min(0).max(255),
}).strict();
const settleSchema = z.tuple([permitSchema, addressSchema, witnessSchema, hexSchema]);
const settleWithPermitSchema = z.tuple([eip2612Schema, permitSchema, addressSchema, witnessSchema, hexSchema]);
const oneAddressSchema = z.tuple([addressSchema]);
const twoAddressSchema = z.tuple([addressSchema, addressSchema]);
const validSignatureSchema = z.tuple([hashSchema, hexSchema]);
const typedDataSchema = z.custom<Eip712TypedData>((value) => typeof value === "object" && value !== null && "domain" in value && "types" in value && "primaryType" in value && "message" in value);

const encodeContractCall = (functionName: string, args: readonly unknown[]): Hex => {
  if (functionName === "settle") {
    const parsed = settleSchema.parse(args);
    return encodeX402ExactSettle(parsed[0], parsed[1], parsed[2], parsed[3]);
  }
  if (functionName === "settleWithPermit") {
    const parsed = settleWithPermitSchema.parse(args);
    return encodeX402ExactSettleWithPermit(parsed[0], parsed[1], parsed[2], parsed[3], parsed[4]);
  }
  throw new Error(`Unsupported x402 contract write: ${functionName}`);
};

const send = async (toValue: string, dataValue: string): Promise<WireHex> => {
  const to = addressSchema.parse(toValue); const data = hexSchema.parse(dataValue);
  const [nonce, gas, gasPrice, priority] = await Promise.all([
    rpc.transactionCount(identity.facilitator), rpc.estimateGas({ from: identity.facilitator, to, data }),
    rpc.gasPrice(), rpc.maxPriorityFeePerGas(),
  ]);
  const raw = await broker.signEip1559({
    chainId: BigInt(manifest.chain.id), nonce, maxPriorityFeePerGas: priority,
    maxFeePerGas: gasPrice * 2n + priority, gas, to, value: 0n, data,
  }, "facilitator");
  return wireHexSchema.parse(await rpc.sendRawTransaction(raw));
};

const readContract = async (args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
  const address = addressSchema.parse(args.address); const values = args.args ?? [];
  if (args.functionName === "balanceOf") return decodeUint256(await rpc.call({ to: address, data: encodeBalanceOf(oneAddressSchema.parse(values)[0]) }));
  if (args.functionName === "allowance") { const parsed = twoAddressSchema.parse(values); return decodeUint256(await rpc.call({ to: address, data: encodeAllowance(parsed[0], parsed[1]) })); }
  if (args.functionName === "PERMIT2") return decodeAddress(await rpc.call({ to: address, data: selector("PERMIT2()") }));
  if (args.functionName === "isValidSignature") { const parsed = validSignatureSchema.parse(values); const result = await rpc.call({ to: address, data: encodeIsValidSignature(parsed[0], parsed[1]) }); return hexSchema.parse(result.slice(0, 10)); }
  if (args.functionName === "settle" || args.functionName === "settleWithPermit") {
    await rpc.call({ from: identity.facilitator, to: address, data: encodeContractCall(args.functionName, values) });
    return undefined;
  }
  throw new Error(`Unsupported x402 contract read: ${args.functionName}`);
};

const signer: FacilitatorEvmSigner = {
  getAddresses: (): readonly `0x${string}`[] => [wireHexSchema.parse(identity.facilitator)],
  readContract,
  verifyTypedData: async (args) => {
    const typedData = typedDataSchema.parse({ domain: args.domain, types: args.types, primaryType: args.primaryType, message: args.message });
    return recoverTypedDataAddress(typedData, hexSchema.parse(args.signature)).toLowerCase() === addressSchema.parse(args.address).toLowerCase();
  },
  writeContract: async (args) => {
    const encoded = encodeContractCall(args.functionName, args.args);
    return send(args.address, args.dataSuffix === undefined ? encoded : concatHex(encoded, hexSchema.parse(args.dataSuffix)));
  },
  sendTransaction: (args) => send(args.to, args.data),
  waitForTransactionReceipt: async (args) => {
    const hash = hashSchema.parse(args.hash); const deadline = Date.now() + (args.timeout ?? 180_000);
    while (Date.now() < deadline) {
      const receipt = await rpc.transactionReceipt(hash);
      if (receipt !== null) return { status: receipt.status };
      await Bun.sleep(500);
    }
    throw new Error(`Receipt wait timed out for ${hash}`);
  },
  getCode: async (args) => { const code = await rpc.getCode(addressSchema.parse(args.address)); return code === "0x" ? undefined : wireHexSchema.parse(code); },
};

const network = `eip155:${String(manifest.chain.id)}` as const;
const facilitator = new x402Facilitator().register(network, new ExactEvmScheme(signer, { simulateInSettle: true }));
const paymentPayloadSchema = z.custom<PaymentPayload>((value) => typeof value === "object" && value !== null && "x402Version" in value && "accepted" in value && "payload" in value);
const paymentRequirementsSchema = z.custom<PaymentRequirements>((value) => typeof value === "object" && value !== null && "scheme" in value && "network" in value && "asset" in value && "amount" in value && "payTo" in value);
const requestSchema = z.object({ x402Version: z.number().int(), paymentPayload: paymentPayloadSchema, paymentRequirements: paymentRequirementsSchema }).strict();
const parsedRequest = async (request: Request): Promise<{ readonly paymentPayload: PaymentPayload; readonly paymentRequirements: PaymentRequirements }> => {
  const parsed = requestSchema.parse(await request.json());
  return { paymentPayload: parsed.paymentPayload, paymentRequirements: parsed.paymentRequirements };
};
const host = new URL(manifest.services.facilitatorUrl);
const server = Bun.serve({ hostname: Bun.env["AQUA_BIND_HOST"]?.trim() ?? host.hostname, port: Number(host.port), routes: {
  "/supported": { GET: () => Response.json(facilitator.getSupported()) },
  "/verify": { POST: async (request) => { const body = await parsedRequest(request); return Response.json(await facilitator.verify(body.paymentPayload, body.paymentRequirements)); } },
  "/settle": { POST: async (request) => { const body = await parsedRequest(request); return Response.json(await facilitator.settle(body.paymentPayload, body.paymentRequirements)); } },
  "/health/live": new Response("ok"),
} });
console.error(JSON.stringify({ level: "info", component: "x402-facilitator", url: server.url.toString(), address: identity.facilitator }));
