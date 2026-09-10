import type { SQL } from "bun";
import { addressSchema, hashSchema, hexSchema, parseStrictJson } from "@aqua/core";
import { encodeExecuteVaultAction } from "@aqua/evm";
import type { ArmedTriggerLeg, TradeTriggerSource } from "@aqua/orderbook";
import { z } from "zod";

const jsonValue = (value: unknown): unknown => (typeof value === "string" ? parseStrictJson(value) : value);
const asRows = <T>(value: T | T[]): readonly T[] => Array.isArray(value) ? value : [value];

const decimalIntegerSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const trailSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("bps"), value: z.string() }).strict(),
  z.object({ unit: z.literal("quote"), value: z.string() }).strict(),
]);
const actionSchema = z.object({
  vault: addressSchema, action: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  strategy: hexSchema, tokens: z.array(addressSchema).min(1).max(8), amounts: z.array(decimalIntegerSchema).min(0).max(8),
  nonce: hashSchema, deadline: decimalIntegerSchema,
}).strict();
const pairSchema = z.object({ baseToken: addressSchema, quoteToken: addressSchema }).strict();
const sizeSchema = z.object({ denomination: z.enum(["base", "quote"]), amount: z.string() }).strict();
interface TriggerRow {
  id: string; trade_id: string; intent_hash: string; group_nonce: string; kind: string; role: string;
  sell_token: string; buy_token: string; trigger_price: string | null; trail: unknown; activation_price: string | null;
  high_water: string | null; size: unknown; action_payload: unknown; signature: string; status: ArmedTriggerLeg["status"];
}

export class PostgresTradeTriggerRepository implements TradeTriggerSource {
  private readonly db: SQL;
  public constructor(db: SQL) { this.db = db; }
  public async listArmed(): Promise<readonly ArmedTriggerLeg[]> {
    const rows = asRows(await this.db<TriggerRow[]>`SELECT id,trade_id,intent_hash,group_nonce,kind,role,sell_token,buy_token,trigger_price,trail,activation_price,high_water,size,action_payload,signature,status FROM trade_triggers WHERE status='armed' LIMIT 1000`);
    return rows.map((row) => {
      const action = actionSchema.parse(jsonValue(row.action_payload));
      const trail = row.trail === null ? null : trailSchema.parse(jsonValue(row.trail));
      return {
        id: row.id, tradeId: row.trade_id, intentHash: hashSchema.parse(row.intent_hash), groupNonce: hashSchema.parse(row.group_nonce),
        kind: row.kind, role: row.role,
        pair: pairSchema.parse({ baseToken: row.sell_token, quoteToken: row.buy_token }),
        side: "sell", size: sizeSchema.parse(jsonValue(row.size)),
        triggerPrice: row.trigger_price, trail, activationPrice: row.activation_price, highWater: row.high_water,
        executeCall: encodeExecuteVaultAction({
          vault: action.vault, action: action.action, strategy: action.strategy, tokens: action.tokens,
          amounts: action.amounts.map(BigInt), nonce: action.nonce, deadline: BigInt(action.deadline),
        }, hexSchema.parse(row.signature)),
        status: row.status,
      };
    });
  }
  public async saveHighWater(id: string, price: string): Promise<void> {
    await this.db`UPDATE trade_triggers SET high_water=${price},updated_at=now() WHERE id=${id}`;
  }
  public async markFiring(id: string, jobId: string): Promise<void> {
    await this.db`UPDATE trade_triggers SET status='firing',fire_job_id=${jobId},updated_at=now() WHERE id=${id} AND status='armed'`;
  }
}
