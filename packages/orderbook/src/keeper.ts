import { hexSchema, quantitySchema } from "@aqua/core";
import type { Address, Hash, Hex, RpcPort } from "@aqua/core";
import type { Eip1559Transaction } from "@aqua/evm";

export interface KeeperJob {
  readonly id: string; readonly target: Address; readonly data: Hex; readonly value: bigint;
  readonly state: "ready" | "submitted"; readonly attempts: number; readonly nonce?: bigint;
  readonly transactionHash?: Hash; readonly submittedAt?: Date; readonly maxFeePerGas?: bigint;
}
export interface KeeperJobRepository {
  claim(worker: string, now: Date, leaseUntil: Date): Promise<KeeperJob | null>;
  markSubmitted(id: string, worker: string, transactionHash: Hash, nonce: bigint, maxFeePerGas: bigint, submittedAt: Date): Promise<void>;
  markComplete(id: string, worker: string, blockNumber: bigint): Promise<void>;
  markFailed(id: string, worker: string, reason: string): Promise<void>;
}
export interface KeeperTransactionSigner { readonly address: Address; sign(transaction: Eip1559Transaction): Hex | Promise<Hex> }
export interface KeeperConfiguration {
  readonly chainId: number; readonly allowedTargets: readonly Address[]; readonly allowedSelectors: readonly Hex[];
  readonly gasLimit: bigint; readonly maxFeePerGas: bigint; readonly replacementSeconds: number; readonly leaseSeconds: number;
}

export class Keeper {
  private readonly repository: KeeperJobRepository; private readonly rpc: RpcPort;
  private readonly signer: KeeperTransactionSigner; private readonly config: KeeperConfiguration; private readonly now: () => Date;
  public constructor(repository: KeeperJobRepository, rpc: RpcPort, signer: KeeperTransactionSigner, config: KeeperConfiguration, now: () => Date = () => new Date()) {
    this.repository = repository; this.rpc = rpc; this.signer = signer; this.config = config; this.now = now;
  }

  public async runOnce(worker: string): Promise<void> {
    const now = this.now();
    const job = await this.repository.claim(worker, now, new Date(now.getTime() + this.config.leaseSeconds * 1_000));
    if (job === null) return;
    try {
      this.validate(job);
      if (job.state === "submitted" && job.transactionHash !== undefined) {
        const receipt = await this.rpc.transactionReceipt(job.transactionHash);
        if (receipt?.status === "success") { await this.repository.markComplete(job.id, worker, receipt.blockNumber); return; }
        if (receipt?.status === "reverted") { await this.repository.markFailed(job.id, worker, "Keeper transaction reverted"); return; }
        if (job.submittedAt !== undefined && now.getTime() - job.submittedAt.getTime() < this.config.replacementSeconds * 1_000) return;
      }
      const nonce = job.nonce ?? await this.rpc.transactionCount(this.signer.address);
      const priority = await this.rpc.maxPriorityFeePerGas();
      const networkFee = await this.rpc.gasPrice();
      const previous = job.maxFeePerGas ?? 0n;
      const replacement = previous === 0n ? 0n : previous + (previous + 7n) / 8n;
      const maxFeePerGas = networkFee * 2n + priority > replacement ? networkFee * 2n + priority : replacement;
      if (maxFeePerGas > this.config.maxFeePerGas) throw new Error("Keeper fee ceiling exceeded");
      const estimated = await this.rpc.estimateGas({ to: job.target, from: this.signer.address, data: job.data, value: quantitySchema.parse(`0x${job.value.toString(16)}`) });
      const gas = estimated + estimated / 5n;
      if (gas > this.config.gasLimit) throw new Error("Keeper gas ceiling exceeded");
      const raw = await this.signer.sign({
        chainId: BigInt(this.config.chainId), nonce, maxPriorityFeePerGas: priority, maxFeePerGas,
        gas, to: job.target, value: job.value, data: job.data,
      });
      const transactionHash = await this.rpc.sendRawTransaction(raw);
      await this.repository.markSubmitted(job.id, worker, transactionHash, nonce, maxFeePerGas, now);
    } catch (error: unknown) {
      await this.repository.markFailed(job.id, worker, error instanceof Error ? error.message : "Unknown keeper failure");
    }
  }

  private validate(job: KeeperJob): void {
    if (!this.config.allowedTargets.includes(job.target)) throw new Error("Keeper target is not allowlisted");
    const selector = hexSchema.parse(job.data.slice(0, 10));
    if (selector.length !== 10 || !this.config.allowedSelectors.includes(selector)) throw new Error("Keeper selector is not allowlisted");
    if (job.value !== 0n) throw new Error("Keeper jobs cannot transfer native value");
  }
}
