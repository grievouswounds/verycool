import { describe, expect, test } from "bun:test";
import { activityListQuerySchema, activityWipeSchema, subscriptionRequestSchema } from "../src/index.ts";

const address = "0x1111111111111111111111111111111111111111";

describe("activity input languages", () => {
  test("accepts minimal subscription and bounded list query", () => {
    expect(String(subscriptionRequestSchema.parse({ address }).address)).toBe(address);
    expect(activityListQuerySchema.parse({ address, limit: "50" }).limit).toBe(50);
  });

  test("rejects unknown and duplicate-language representations", () => {
    expect(subscriptionRequestSchema.safeParse({ address, chainId: 1 }).success).toBe(false);
    expect(activityListQuerySchema.safeParse({ limit: "01" }).success).toBe(false);
  });

  test("requires explicit confirmation for an all-data wipe", () => {
    expect(activityWipeSchema.safeParse({ scope: "all" }).success).toBe(false);
    expect(activityWipeSchema.safeParse({ scope: "all", confirmation: "WIPE_ALL_ERC20_ACTIVITY" }).success).toBe(true);
  });
});
