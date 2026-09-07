import { parse, toSafeNumberOrThrow } from "lossless-json";
import secureJsonParse from "secure-json-parse";

/** One JSON recognizer for all HTTP bodies. Duplicate and dangerous keys are outside the language. */
export const parseStrictJson = (text: string): unknown => {
  secureJsonParse(text, { protoAction: "error", constructorAction: "error" });
  return parse(text, undefined, { parseNumber: (value) => toSafeNumberOrThrow(value) });
};
