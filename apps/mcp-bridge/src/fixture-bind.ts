import type { Address, TokenReference } from "@aqua/core";
import { matchFixtureTokens } from "@aqua/core";

export const bindFixtureToken = (
  token: TokenReference,
  tokens: readonly { readonly address: Address; readonly symbol: string }[],
): TokenReference => {
  if (token.type !== "search") return token;
  const matches = matchFixtureTokens(tokens, token.query);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match === undefined ? token : { type: "address", address: match.address };
};
