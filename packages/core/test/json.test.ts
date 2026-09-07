import { describe, expect, test } from "bun:test";
import { parseStrictJson } from "../src/index.ts";

describe("strict JSON recognizer", () => {
  test("rejects duplicate and prototype-sensitive object keys", () => {
    expect(() => parseStrictJson('{"address":"a","address":"b"}')).toThrow();
    expect(() => parseStrictJson('{"__proto__":{}}')).toThrow();
  });

  test("rejects integers that cannot be represented safely", () => {
    expect(() => parseStrictJson('{"value":9007199254740992}')).toThrow();
  });
});
