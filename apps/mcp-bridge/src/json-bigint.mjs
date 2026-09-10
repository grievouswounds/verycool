const nativeStringify = JSON.stringify.bind(JSON);
const bigintReplacer = (_key, item) => typeof item === "bigint" ? item.toString() : item;
JSON.stringify = (value, replacer, space) => {
  const root = typeof value === "bigint" ? value.toString() : value;
  if (replacer === undefined) return nativeStringify(root, bigintReplacer, space);
  return nativeStringify(root, replacer, space);
};
