export const matchFixtureTokens = <T extends { readonly address: string; readonly symbol: string }>(
  tokens: readonly T[],
  query: string,
): readonly T[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return tokens.filter((token) => token.symbol.toLowerCase() === needle || token.address.toLowerCase() === needle);
};
