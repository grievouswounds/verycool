import { AUTHENTICATION_SCOPES, hashSchema, hexSchema } from "@aqua/core";
import type { Hex, RuntimeManifest } from "@aqua/core";
import { bytesToHex, CubaneTransactionSigner, hexToBytes, initializeCubane, signingKeyAddress } from "@aqua/evm";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sign as signPaseto } from "paseto-ts/v4";
import type { BrokerAccessTokenGrant, BrokerDigestRequest, BrokerEip1559Transaction, SecretBroker } from "./broker.ts";
import { brokerIdentitySchema } from "./broker.ts";

const required = (name: string): string => {
  const value = Bun.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const pasetoPublicFromSecret = (secret: string): string => {
  if (!/^k4\.secret\.[A-Za-z0-9_-]{86}$/u.test(secret)) throw new Error("Broker PASETO key is invalid");
  const secretBytes = Buffer.from(secret.slice("k4.secret.".length), "base64url");
  if (secretBytes.length !== 64) throw new Error("PASETO secret key length is invalid");
  return `k4.public.${Buffer.from(secretBytes.subarray(32)).toString("base64url")}`;
};

export class EnvKeySecretBroker implements SecretBroker {
  private readonly manifest: RuntimeManifest;
  private readonly keys: { readonly agent: Hex; readonly facilitator: Hex; readonly keeper: Hex; readonly paseto: string };
  private readonly publicIdentity: ReturnType<typeof brokerIdentitySchema.parse>;
  private readonly spent = new Map<string, bigint>();

  public constructor(manifest: RuntimeManifest) {
    initializeCubane();
    const agent = hexSchema.parse(required("AQUA_AGENT_KEY"));
    const facilitator = hexSchema.parse(required("AQUA_FACILITATOR_KEY"));
    const keeper = hexSchema.parse(required("AQUA_KEEPER_KEY"));
    const paseto = required("PASETO_V4_SECRET_KEY");
    if (agent.length !== 66 || facilitator.length !== 66 || keeper.length !== 66) throw new Error("Broker EVM keys must be 32 bytes");
    this.manifest = manifest;
    this.keys = { agent, facilitator, keeper, paseto };
    this.publicIdentity = brokerIdentitySchema.parse({
      agent: signingKeyAddress(agent), facilitator: signingKeyAddress(facilitator),
      keeper: signingKeyAddress(keeper), pasetoPublicKey: pasetoPublicFromSecret(paseto),
    });
    if (this.publicIdentity.pasetoPublicKey !== manifest.auth.pasetoPublicKeys[0]) {
      throw new Error("Env signer PASETO identity does not match runtime manifest");
    }
  }

  public async identity() { return this.publicIdentity; }

  public async issuePaseto(grant: BrokerAccessTokenGrant): Promise<string> {
    const now = new Date();
    const scopes = AUTHENTICATION_SCOPES.filter((scope) => grant.scopes.includes(scope));
    if (scopes.length !== grant.scopes.length) throw new Error("Unsupported token scope");
    const { blake2b } = await import("@noble/hashes/blake2b");
    const kid = `k4.pid.${Buffer.from(blake2b(new TextEncoder().encode(`k4.pid.${this.publicIdentity.pasetoPublicKey}`), { dkLen: 33 })).toString("base64url")}`;
    return signPaseto(this.keys.paseto, {
      iss: this.manifest.auth.issuer, aud: this.manifest.auth.resource, sub: grant.address,
      iat: now.toISOString(), exp: new Date(now.getTime() + 600_000).toISOString(),
      jti: crypto.randomUUID(), sid: grant.sessionId, chain_id: this.manifest.chain.id,
      scope: scopes.join(" "), amr: grant.amr, client_id: grant.clientId,
    }, { footer: { kid }, addIat: false, addExp: false });
  }

  public async signEip1559(transaction: BrokerEip1559Transaction, purpose: "keeper" | "facilitator" = "keeper"): Promise<Hex> {
    const keeperAllowed = this.manifest.keeper.allowedTargets.includes(transaction.to)
      && this.manifest.keeper.allowedSelectors.includes(transaction.data.slice(0, 10));
    const facilitatorAllowed = transaction.to === this.manifest.contracts.x402ExactPermit2Proxy.address;
    const allowed = purpose === "keeper" ? keeperAllowed : facilitatorAllowed;
    if (transaction.chainId !== BigInt(this.manifest.chain.id) || !allowed) throw new Error("Signer chain, target, or selector is outside policy");
    if (transaction.value !== 0n || transaction.gas > 8_000_000n || transaction.maxFeePerGas > 100_000_000_000n) {
      throw new Error("Signer value, gas, or fee exceeds policy");
    }
    const signer = new CubaneTransactionSigner(purpose === "keeper" ? this.keys.keeper : this.keys.facilitator);
    return signer.sign({ ...transaction, value: 0n });
  }

  public async signDigest(parameters: BrokerDigestRequest): Promise<Hex> {
    if (parameters.chainId !== this.manifest.chain.id) throw new Error("Chain is outside broker policy");
    if (!this.manifest.fixtures.tokens.some((token) => token.address === parameters.token)) throw new Error("Token is outside broker policy");
    if (parameters.purpose === "permit2" && parameters.proxy !== this.manifest.contracts.x402ExactPermit2Proxy.address) {
      throw new Error("Permit2 proxy mismatch");
    }
    if (BigInt(parameters.deadline) > BigInt(Math.floor(Date.now() / 1_000) + 300)) throw new Error("Deadline exceeds broker policy");
    const amount = BigInt(parameters.amount);
    const bucket = `${parameters.token}:${new Date().toISOString().slice(0, 10)}`;
    const next = (this.spent.get(bucket) ?? 0n) + amount;
    if (amount <= 0n || next > 10n ** 30n) throw new Error("Amount exceeds broker policy");
    const key = parameters.purpose === "facilitator" ? this.keys.facilitator : parameters.purpose === "keeper" ? this.keys.keeper : this.keys.agent;
    const signature = secp256k1.sign(hexToBytes(hashSchema.parse(parameters.digest)), hexToBytes(key));
    this.spent.set(bucket, next);
    return hexSchema.parse(`${bytesToHex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`);
  }
}

