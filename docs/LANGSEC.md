# Language-theoretic security model

Every untrusted interface is treated as a language recognizer. Parsing happens once at the boundary, produces branded domain values, and downstream code cannot receive the original untyped representation.

## HTTP language

- Requests are bounded to 64 KiB before JSON interpretation.
- `Content-Type` is parsed as a media type and must equal `application/json`; prefix matches are not accepted.
- Declared lengths have a bounded canonical decimal grammar. Invalid UTF-8 is rejected using a fatal decoder.
- JSON is recognized with duplicate-key rejection, prototype-sensitive-key rejection, and lossless-number safety before strict Zod object grammars. Unknown properties and ambiguous unions are rejected.
- Decimal token amounts accept only `0|[1-9][0-9]*` with an optional dot and digits. Signs, whitespace, separators, hexadecimal and exponent notation are outside the language.
- Trading is one top-level discriminated union and every nested choice is another closed union. Order kinds, GTD lifetime forms, cancellation scopes, batch operations, query resources, size denominations, trails, and bracket entries have no precedence or fallback productions.
- Trading decimals are at most 160 characters; page limits, book depth, cursors, arrays, cancellation sets, and batches have independent hard bounds. Decimal-to-atomic conversion rejects token precision overflow before any protocol call.
- Hex bytes, addresses, hashes, UUIDs, timestamps, enums and bounded integers each have one explicit recognizer.
- The configured chain is not part of the body language, preventing cross-chain interpretation.
- Bearer access tokens are bounded PASETO `v4.public` strings. The unverified footer has a small canonical base64url/JSON grammar and may select only a preconfigured `k4.pid` key; the authenticated footer and strict claim object are validated again after signature verification.
- Access-token issuer, audience/resource, chain, subject, session, expiry, and scope claims are recognized explicitly. Tokens issued for another resource or chain are rejected, preventing token passthrough across future MCP resource servers.
- `AQUA-AUTHORIZATION` is canonical bounded base64url carrying one strict JSON object. The command hash is recomputed from the already-normalized command; EOA/EIP-1271 verification occurs before the nonce is atomically consumed.

## EVM and RPC languages

- Only explicitly implemented EIP-1474 methods can be emitted. Callers cannot supply method names or arbitrary parameter shapes.
- Responses are limited to 1 MiB, decoded as strict UTF-8, parsed once, and recognized as an exact success or failure envelope with a matching monotonic ID.
- Byte strings and RPC quantities have separate grammars. Quantities reject leading zeroes.
- Contract return values are decoded through exact Cubane ABI types before they enter the domain.
- SwapVM programs are parsed as length-delimited instructions and checked against router-specific opcode allowlists.
- ERC-20 logs accept only the exact `Transfer(address,address,uint256)` topic language: three 32-byte topics, canonical zero-padded indexed addresses, one 32-byte uint256 data word, canonical RPC quantities, and `removed !== true`.
- Numeric conversion uses strings and `bigint`; floating-point arithmetic is never used for token amounts or slippage.
- The order worker asks for logs only from its bounded configured address allowlist. Exact Cubane tuple decoders recognize the five current Aqua/SwapVM event signatures; malformed known events halt the checkpoint, while unrelated topics cannot enter derived state. `Shipped` strategies must decode as a SwapVM order whose maker matches the event and whose bytecode has the exact deadline/salt/static-balances/invalidator/limit instruction grammar. Orders, fills, raw evidence, and checkpoint commit in one transaction and are replayed after a fork.
- Keeper jobs accept no native value and only configured targets plus exact four-byte selectors. The private key is a bounded secret-file grammar. Nonces, gas, fees, receipts, replacement timing, leases, and terminal states have explicit typed transitions. A trigger proof is the hash of at most eight sorted compatible order hashes and must cover the complete requested base size for two independent block/time thresholds.

## Output language

Responses are constructed from typed values. Token amounts are rendered as ordinary decimal strings with token metadata. Transactions expose canonical RPC quantities and byte strings. All errors use one bounded RFC 9457 object shape with stable machine-readable `type` identifiers.

The negative test corpus covers malformed decimals, ambiguous choices, unknown fields, truncated programs, malformed RPC envelopes and non-canonical quantities. New input syntax must begin with a failing recognizer test.

Activity query strings use an allowlisted key language and reject duplicate keys. Opaque cursors have bounded base64url syntax and decode to one timestamp/action-key production. Subscription ownership comes only from the authenticated PASETO subject and can never be supplied in a request.
