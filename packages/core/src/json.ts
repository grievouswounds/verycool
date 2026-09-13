import { parse, toSafeNumberOrThrow } from "lossless-json";
import secureJsonParse from "secure-json-parse";
import { AppError } from "./errors.ts";

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_HTTP_BODY_BYTES = 65_536;
export const MAX_SUBPROCESS_BYTES = 1_048_576;
export const MAX_ENVELOPE_BYTES = 4_096;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/u;

/** One JSON recognizer for all HTTP bodies. Duplicate and dangerous keys are outside the language. */
export const parseStrictJson = (text: string): unknown => {
  secureJsonParse(text, { protoAction: "error", constructorAction: "error" });
  return parse(text, undefined, { parseNumber: (value) => toSafeNumberOrThrow(value) });
};

export const responseBytes = async (response: Response, maximum: number): Promise<Uint8Array> => {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/u.test(length) || BigInt(length) > BigInt(maximum))) {
    throw new Error("HTTP response exceeds the configured byte limit");
  }
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reading = true;
  while (reading) {
    const item = await reader.read();
    if (item.done) reading = false;
    else {
      size += item.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("HTTP response exceeds the configured byte limit");
      }
      chunks.push(item.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

export const readBoundedText = async (response: Response, maximum = DEFAULT_MAX_RESPONSE_BYTES): Promise<string> =>
  new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, maximum));

export const readBoundedJson = async (response: Response, maximum = DEFAULT_MAX_RESPONSE_BYTES): Promise<unknown> =>
  parseStrictJson(await readBoundedText(response, maximum));

export const readBoundedFileText = async (path: string, maximum = MAX_SUBPROCESS_BYTES): Promise<string> => {
  const file = Bun.file(path);
  if (file.size > maximum) throw new Error("File exceeds the configured byte limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await file.arrayBuffer()));
};

export const readBoundedFileJson = async (path: string, maximum = MAX_SUBPROCESS_BYTES): Promise<unknown> =>
  parseStrictJson(await readBoundedFileText(path, maximum));

/** One recognizer for the base64url-wrapped JSON envelope used by cursors and headers. */
export const decodeBase64urlJson = (value: string, maximumBytes = MAX_ENVELOPE_BYTES): unknown => {
  if (value.includes("=") || !BASE64URL_ALPHABET.test(value)) throw new Error("base64url envelope is not canonical");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength > maximumBytes) throw new Error("base64url envelope exceeds the configured byte limit");
  if (decoded.toString("base64url") !== value) throw new Error("base64url envelope is not canonical");
  return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
};

export const parseBoundedJsonRequest = async (request: Request, maximum = MAX_HTTP_BODY_BYTES): Promise<unknown> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new AppError(415, "urn:aqua:error:content-type", "Content-Type must be application/json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^(?:0|[1-9][0-9]{0,5})$/u.test(contentLength)) {
    throw new AppError(400, "urn:aqua:error:content-length", "Content-Length is not canonical");
  }
  if (contentLength !== null && Number(contentLength) > maximum) throw new AppError(413, "urn:aqua:error:body-size", `Request body exceeds ${String(maximum)} bytes`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maximum) throw new AppError(413, "urn:aqua:error:body-size", `Request body exceeds ${String(maximum)} bytes`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new AppError(400, "urn:aqua:error:utf8", "Request body must be valid UTF-8"); }
  try { return parseStrictJson(text); }
  catch { throw new AppError(400, "urn:aqua:error:json", "Malformed JSON body"); }
};
