import { describe, expect, test } from "bun:test";

describe("hosted capabilities copy", () => {
  test("advertises hosted Streamable HTTP /mcp", async () => {
    const source = await Bun.file(new URL("../src/server.ts", import.meta.url)).text();
    expect(source).toContain("hosted Streamable HTTP /mcp with OAuth");
  });
});
