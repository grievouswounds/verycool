import { describe, expect, test } from "bun:test";
import {
  decodeBase64urlJson, parseBoundedJsonRequest, parseStrictJson, readBoundedJson, readBoundedText,
} from "../src/index.ts";

describe("strict JSON recognizer", () => {
  test("rejects duplicate and prototype-sensitive object keys", () => {
    expect(() => parseStrictJson('{"address":"a","address":"b"}')).toThrow();
    expect(() => parseStrictJson('{"__proto__":{}}')).toThrow();
    expect(() => parseStrictJson('{"constructor":{"prototype":{}}}')).toThrow();
  });

  test("rejects integers that cannot be represented safely", () => {
    expect(() => parseStrictJson('{"value":9007199254740992}')).toThrow();
  });
});

describe("bounded HTTP JSON", () => {
  const rejects = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error: unknown) {
      return error;
    }
    throw new Error("expected the recognizer to reject");
  };

  test("rejects oversize bodies by declared and actual length", async () => {
    expect(await rejects(() => readBoundedJson(new Response('{"ok":true}', { headers: { "content-length": "9" } }), 4))).toBeInstanceOf(Error);
    expect(await rejects(() => readBoundedText(new Response("hello world"), 4))).toBeInstanceOf(Error);
  });

  test("rejects invalid UTF-8", async () => {
    expect(await rejects(() => readBoundedText(new Response(new Uint8Array([0xff, 0xfe]))))).toBeInstanceOf(Error);
  });

  test("rejects duplicate keys after a bounded decode", async () => {
    expect(await rejects(() => readBoundedJson(new Response('{"id":1,"id":2}')))).toBeInstanceOf(Error);
  });
});

describe("bounded JSON request", () => {
  const rejects = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error: unknown) {
      return error;
    }
    throw new Error("expected the recognizer to reject");
  };

  test("rejects non-json media types and oversized declared lengths", async () => {
    expect(await rejects(() => parseBoundedJsonRequest(new Request("http://aqua.invalid", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    })))).toMatchObject({ status: 415 });
    expect(await rejects(() => parseBoundedJsonRequest(new Request("http://aqua.invalid", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "70000" }, body: "{}",
    })))).toMatchObject({ status: 413 });
  });
});

describe("base64url JSON envelope", () => {
  test("accepts canonical envelopes and rejects padding, alphabet, oversize, and unsafe JSON", () => {
    const encoded = Buffer.from('{"at":"2026-01-01T00:00:00.000Z","id":"a"}').toString("base64url");
    expect(decodeBase64urlJson(encoded)).toEqual({ at: "2026-01-01T00:00:00.000Z", id: "a" });
    expect(() => decodeBase64urlJson(`${encoded}=`)).toThrow(/canonical/);
    expect(() => decodeBase64urlJson("@@@")).toThrow(/canonical/);
    expect(() => decodeBase64urlJson(Buffer.from("x".repeat(8)).toString("base64url"), 2)).toThrow(/byte limit/);
    expect(() => decodeBase64urlJson(Buffer.from('{"a":1,"a":2}').toString("base64url"))).toThrow();
    expect(() => decodeBase64urlJson(Buffer.from('{"__proto__":{}}').toString("base64url"))).toThrow();
    expect(() => decodeBase64urlJson(Buffer.from('{"value":9007199254740992}').toString("base64url"))).toThrow();
  });
});
