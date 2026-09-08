import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { generateKeys, sign as signPaseto } from "paseto-ts/v4";
import { secp256k1 } from "@noble/curves/secp256k1";
import { AUTHENTICATION_SCOPES, hashSchema, hexSchema, loadRuntimeManifest, parseStrictJson } from "@aqua/core";
import type { Address, AuthenticationScope, RuntimeManifest } from "@aqua/core";
import { bytesToHex, CubaneTransactionSigner, hexToBytes, initializeCubane } from "@aqua/evm";
import { brokerRequestSchema } from "@aqua/security";

const argument = (name: string): string => {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? undefined : Bun.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};
const fixture = Bun.argv.includes("--fixture");
const socketPath = argument("--socket");
const identityOut = argument("--identity-out");
const configPath = argument("--config");
const ringDirectory = fixture ? null : argument("--ring-dir");

const decrypt = async (name: string): Promise<string> => {
  if (ringDirectory === null) throw new Error("Ring directory is unavailable in fixture mode");
  const process = Bun.spawn(["wallet-cli", "ring", "decrypt", "-i", `${ringDirectory}/${name}.enc`, "--key", name], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Key Ring failed for ${name}: ${stderr.trim().slice(0, 160)}`);
  return stdout.trim();
};
const randomPrivateKey = (): string => {
  let key: Uint8Array;
  do { key = crypto.getRandomValues(new Uint8Array(32)); } while (!secp256k1.utils.isValidPrivateKey(key));
  return bytesToHex(key);
};

const pasetoPair = fixture ? generateKeys("public") : null;
const keys = {
  agent: hexSchema.parse(fixture ? randomPrivateKey() : await decrypt("agent")),
  facilitator: hexSchema.parse(fixture ? randomPrivateKey() : await decrypt("facilitator")),
  keeper: hexSchema.parse(fixture ? randomPrivateKey() : await decrypt("keeper")),
  paseto: fixture ? pasetoPair?.secretKey ?? "" : await decrypt("paseto"),
};
if (keys.agent.length !== 66 || keys.facilitator.length !== 66 || keys.keeper.length !== 66) throw new Error("Broker EVM keys must be 32 bytes");
if (!/^k4\.secret\.[A-Za-z0-9_-]{86}$/u.test(keys.paseto)) throw new Error("Broker PASETO key is invalid");
initializeCubane();
const signerAddress = (key: typeof keys.agent): Address => new CubaneTransactionSigner(key).address;
const encodedPaseto = keys.paseto.slice("k4.secret.".length);
const secretBytes = Buffer.from(encodedPaseto, "base64url");
if (secretBytes.length !== 64) throw new Error("PASETO secret key length is invalid");
const pasetoPublicKey = `k4.public.${Buffer.from(secretBytes.subarray(32)).toString("base64url")}`;
const identity = {
  agent: signerAddress(keys.agent), facilitator: signerAddress(keys.facilitator),
  keeper: signerAddress(keys.keeper), pasetoPublicKey,
};
await Bun.write(identityOut, `${JSON.stringify(identity, null, 2)}\n`);

let cachedManifest: RuntimeManifest | null = null;
const manifest = async (): Promise<RuntimeManifest> => {
  cachedManifest ??= await loadRuntimeManifest(["--config", configPath]);
  if (!cachedManifest.auth.pasetoPublicKeys.includes(pasetoPublicKey)) throw new Error("Broker PASETO identity does not match manifest");
  return cachedManifest;
};
const footerKeyId = async (): Promise<string> => {
  const { blake2b } = await import("@noble/hashes/blake2b");
  return `k4.pid.${Buffer.from(blake2b(new TextEncoder().encode(`k4.pid.${pasetoPublicKey}`), { dkLen: 33 })).toString("base64url")}`;
};
const issueToken = async (parameters: {
  address: Address; sessionId: string; scopes: readonly AuthenticationScope[];
  amr: readonly ("siwe" | "fido2" | "hwk")[]; clientId: string;
}): Promise<string> => {
  const config = await manifest();
  const now = new Date();
  const scopes = AUTHENTICATION_SCOPES.filter((scope) => parameters.scopes.includes(scope));
  if (scopes.length !== parameters.scopes.length) throw new Error("Unsupported token scope");
  return signPaseto(keys.paseto, {
    iss: config.auth.issuer, aud: config.auth.resource, sub: parameters.address,
    iat: now.toISOString(), exp: new Date(now.getTime() + 600_000).toISOString(),
    jti: crypto.randomUUID(), sid: parameters.sessionId, chain_id: config.chain.id,
    scope: scopes.join(" "), amr: parameters.amr, client_id: parameters.clientId,
  }, { footer: { kid: await footerKeyId() }, addIat: false, addExp: false });
};

const spent = new Map<string, bigint>();
const signDigest = async (parameters: {
  purpose: "permit2" | "order-lifecycle" | "keeper" | "facilitator";
  digest: string; chainId: number; token: Address; vault: Address; proxy: Address; amount: string; deadline: string;
}) => {
  const config = await manifest();
  if (parameters.chainId !== config.chain.id) throw new Error("Chain is outside broker policy");
  if (!config.fixtures.tokens.some((token) => token.address === parameters.token)) throw new Error("Token is outside broker policy");
  if (parameters.purpose === "permit2" && parameters.proxy !== config.contracts.x402ExactPermit2Proxy.address) throw new Error("Permit2 proxy mismatch");
  if (BigInt(parameters.deadline) > BigInt(Math.floor(Date.now() / 1_000) + 300)) throw new Error("Deadline exceeds broker policy");
  const amount = BigInt(parameters.amount);
  const bucket = `${parameters.token}:${new Date().toISOString().slice(0, 10)}`;
  const next = (spent.get(bucket) ?? 0n) + amount;
  if (amount <= 0n || next > 10n ** 30n) throw new Error("Amount exceeds broker policy");
  const key = parameters.purpose === "facilitator" ? keys.facilitator : parameters.purpose === "keeper" ? keys.keeper : keys.agent;
  const signature = secp256k1.sign(hexToBytes(hashSchema.parse(parameters.digest)), hexToBytes(key));
  const recovery = signature.recovery;
  spent.set(bucket, next);
  return { signature: hexSchema.parse(`${bytesToHex(signature.toCompactRawBytes())}${(27 + recovery).toString(16)}`) };
};
const signEip1559=async(parameters:{chainId:string;nonce:string;maxPriorityFeePerGas:string;maxFeePerGas:string;gas:string;to:Address;value:string;data:string})=>{const config=await manifest();const chainId=BigInt(parameters.chainId);const gas=BigInt(parameters.gas);const maxFeePerGas=BigInt(parameters.maxFeePerGas);if(chainId!==BigInt(config.chain.id)||!config.keeper.allowedTargets.includes(parameters.to))throw new Error("Keeper chain or target is outside policy");if(parameters.data.length<10||!config.keeper.allowedSelectors.includes(parameters.data.slice(0,10)))throw new Error("Keeper selector is outside policy");if(BigInt(parameters.value)!==0n||gas>1_000_000n||maxFeePerGas>100_000_000_000n)throw new Error("Keeper value, gas, or fee exceeds policy");const signer=new CubaneTransactionSigner(keys.keeper);return {rawTransaction:signer.sign({chainId,nonce:BigInt(parameters.nonce),maxPriorityFeePerGas:BigInt(parameters.maxPriorityFeePerGas),maxFeePerGas,gas,to:parameters.to,value:0n,data:hexSchema.parse(parameters.data)})};};

try { await Bun.file(socketPath).delete(); } catch { /* socket does not exist */ }
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buffered = "";
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > 65_536) { socket.destroy(); return; }
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    void (async () => {
      let id: string = crypto.randomUUID();
      try {
        const decoded = brokerRequestSchema.parse(parseStrictJson(line));
        id = decoded.id;
        const result = decoded.method === "getPublicIdentity" ? identity
          : decoded.method === "issuePaseto" ? { token: await issueToken(decoded.params) }
          : decoded.method === "signEip1559" ? await signEip1559(decoded.params)
          : await signDigest(decoded.params);
        socket.end(`${JSON.stringify({ id, ok: true, result })}\n`);
      } catch (error: unknown) {
        socket.end(`${JSON.stringify({ id, ok: false, error: { code: "policy_rejected", message: error instanceof Error ? error.message : "Broker request failed" } })}\n`);
      }
    })();
  });
});
server.listen(socketPath, () => { void chmod(socketPath, 0o600); });
console.log(JSON.stringify({ level: "info", component: "secret-broker", socket: socketPath, fixture }));
