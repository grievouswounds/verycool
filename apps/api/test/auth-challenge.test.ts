import { describe, expect, test } from "bun:test";
import { AppError } from "@aqua/core";
import { authenticationChallenge } from "../src/server.ts";

describe("Bearer authentication challenges", () => {
  test("distinguishes missing, invalid, and insufficiently scoped tokens", () => {
    expect(authenticationChallenge(new AppError(401, "urn:aqua:error:authentication", "Missing"))).toBe("Bearer");
    expect(authenticationChallenge(new AppError(401, "urn:aqua:error:authentication", "Invalid", { bearerError: "invalid_token" }))).toBe('Bearer error="invalid_token"');
    expect(authenticationChallenge(new AppError(403, "urn:aqua:error:scope", "Scope", { requiredScope: "trading:write" }))).toBe('Bearer error="insufficient_scope", scope="trading:write"');
  });
});
