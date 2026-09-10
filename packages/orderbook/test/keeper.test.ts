import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { Address, Hash, Hex, RpcBlock, RpcLog, RpcReceipt } from "@aqua/core";
import { Keeper } from "../src/index.ts";
import type { KeeperJob, KeeperJobRepository, KeeperTransactionSigner } from "../src/index.ts";

const target = addressSchema.parse("0x1111111111111111111111111111111111111111");
const workerAddress = addressSchema.parse("0x2222222222222222222222222222222222222222");
const transactionHash = hashSchema.parse(`0x${"33".repeat(32)}`);
const selector = hexSchema.parse("0x12345678");
const readyJob = (jobTarget: Address): KeeperJob => ({ id: "job", target: jobTarget, data: hexSchema.parse("0x1234567800"), value: 0n, state: "ready", attempts: 0 });

class Repository implements KeeperJobRepository {
  public job: KeeperJob | null = readyJob(target);
  public submitted: Hash | null = null; public completed = false; public failed: string | null = null;
  public async claim() { const claimed = this.job; this.job = null; return claimed; }
  public async markSubmitted(_id: string, _worker: string, hash: Hash) { this.submitted = hash; }
  public async markComplete() { this.completed = true; }
  public async markFailed(_id: string, _worker: string, reason: string) { this.failed = reason; }
  public async release() { this.job = readyJob(target); }
}
class Signer implements KeeperTransactionSigner { public readonly address = workerAddress; public sign(): Hex { return hexSchema.parse("0x02"); } }
class Rpc {
  public receipt: RpcReceipt | null = null;
  public async chainId() { return 1; } public async getCode() { return hexSchema.parse("0x01"); }
  public async call() { return hexSchema.parse("0x"); } public async estimateGas() { return 100_000n; }
  public async tokenDecimals() { return 18; } public async tokenSymbol() { return null; } public async blockNumber() { return 1n; }
  public async block(): Promise<RpcBlock> { return { number: 1n, hash: transactionHash, timestamp: 1n }; }
  public async logs(): Promise<readonly RpcLog[]> { return []; }
  public async transactionCount() { return 7n; } public async gasPrice() { return 10n; }
  public async maxPriorityFeePerGas() { return 2n; } public async sendRawTransaction() { return transactionHash; }
  public async transactionReceipt() { return this.receipt; }
}

const configuration = { chainId: 1, allowedTargets: [target], allowedSelectors: [selector], gasLimit: 200_000n, maxFeePerGas: 100n, replacementSeconds: 60, leaseSeconds: 30 };

describe("keeper transaction state machine", () => {
  test("validates policy, signs, and records a submitted transaction", async () => {
    const repository = new Repository();
    await new Keeper(repository, new Rpc(), new Signer(), configuration).runOnce("worker");
    expect(repository.submitted).toBe(transactionHash); expect(repository.failed).toBeNull();
  });

  test("rejects a target outside the immutable allowlist", async () => {
    const repository = new Repository();
    repository.job = readyJob(addressSchema.parse("0x4444444444444444444444444444444444444444"));
    await new Keeper(repository, new Rpc(), new Signer(), configuration).runOnce("worker");
    expect(repository.failed).toBe("Keeper target is not allowlisted");
  });

  test("releases a job whose gas estimate is not yet executable", async () => {
    const repository = new Repository();
    repository.job = { ...readyJob(target), attempts: 1 };
    class RevertingRpc extends Rpc {
      public override async estimateGas(): Promise<bigint> { throw new Error("execution reverted: TriggerNotPersistent"); }
    }
    await new Keeper(repository, new RevertingRpc(), new Signer(), configuration).runOnce("worker");
    expect(repository.failed).toBeNull();
    expect(repository.submitted).toBeNull();
  });
});
