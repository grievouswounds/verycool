import { hexSchema, validationError } from "@aqua/core";
import type { Address, Hex } from "@aqua/core";
import { bytesToHex, concatHex, hexToBytes } from "@aqua/evm";

/**
 * LimitOpcodes._opcodes() overlays length 41 over static slot 0, so dynamic[i] = static[i+1].
 * VM.runLoop dispatches opcodes[opcode] (not opcode-1). Official ProgramBuilder.findOpcode
 * returns that dynamic index, so opcode n runs static[n+1]:
 * _deadline 14 → 13, _staticBalancesXD 18 → 17, _invalidateBit1D 19 → 18,
 * _invalidateTokenOut1D 21 → 20, _limitSwap1D 22 → 21, _limitSwapOnlyFull1D 23 → 22, _salt 31 → 30.
 * _jump 11 → 10. Aqua preloads strategy balances, so programs jump over `_staticBalancesXD`.
 */
export const LIMIT_OPCODES = {
  jump: 10,
  deadline: 13,
  staticBalances: 17,
  invalidateBit: 18,
  invalidateTokenOut: 20,
  limitSwap: 21,
  limitSwapOnlyFull: 22,
  salt: 30,
} as const;

const unsignedBytes = (value: bigint, length: number): Uint8Array => {
  if (value < 0n || value >= 1n << BigInt(length * 8)) throw validationError(`Value does not fit uint${String(length * 8)}`);
  const result = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
};

const instruction = (opcode: number, args: Uint8Array = new Uint8Array()): Hex => {
  if (args.length > 255) throw validationError("Instruction arguments exceed 255 bytes");
  return bytesToHex(Uint8Array.from([opcode, args.length, ...args]));
};

const addressBytes = (address: Address): Uint8Array => hexToBytes(address);

export interface LimitProgramInput {
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly expiresAtSeconds: bigint;
  readonly salt: Hex;
  readonly fill: { readonly type: "partial" } | { readonly type: "allOrNothing"; readonly nonce: number };
}

export const buildLimitProgram = (input: LimitProgramInput): Hex => {
  const tokenIn = input.buyToken;
  const tokenOut = input.sellToken;
  const balances = Uint8Array.from([
    ...unsignedBytes(2n, 2), ...addressBytes(tokenIn), ...addressBytes(tokenOut),
    ...unsignedBytes(input.buyAmount, 32), ...unsignedBytes(input.sellAmount, 32),
  ]);
  const direction = BigInt(tokenIn) < BigInt(tokenOut) ? 1 : 0;
  const invalidator = input.fill.type === "partial"
    ? instruction(LIMIT_OPCODES.invalidateTokenOut)
    : instruction(LIMIT_OPCODES.invalidateBit, unsignedBytes(BigInt(input.fill.nonce), 4));
  const limit = instruction(
    input.fill.type === "partial" ? LIMIT_OPCODES.limitSwap : LIMIT_OPCODES.limitSwapOnlyFull,
    Uint8Array.from([direction]),
  );
  const deadlineIx = instruction(LIMIT_OPCODES.deadline, unsignedBytes(input.expiresAtSeconds, 5));
  const saltIx = instruction(LIMIT_OPCODES.salt, hexToBytes(input.salt));
  const balancesIx = instruction(LIMIT_OPCODES.staticBalances, balances);
  // Aqua quote/swap preload safeBalances into the VM registers, so executing
  // _staticBalancesXD would revert SetBalancesExpectZeroBalances. Jump over it;
  // the instruction remains in the bytecode so the indexer can still read the rate.
  const skipTo = hexToBytes(concatHex(deadlineIx, saltIx)).length + 4 + hexToBytes(balancesIx).length;
  if (skipTo > 0xffff) throw validationError("Limit program exceeds jump range");
  return concatHex(
    deadlineIx, saltIx, instruction(LIMIT_OPCODES.jump, unsignedBytes(BigInt(skipTo), 2)),
    balancesIx, invalidator, limit,
  );
};

export interface DecodedInstruction { readonly opcode: number; readonly arguments: Hex }

export const decodeProgram = (program: Hex): readonly DecodedInstruction[] => {
  const bytes = hexToBytes(program);
  const result: DecodedInstruction[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 2 > bytes.length) throw validationError("Truncated instruction header");
    const opcode = bytes[cursor];
    const length = bytes[cursor + 1];
    if (opcode === undefined || length === undefined) throw validationError("Truncated instruction header");
    cursor += 2;
    if (cursor + length > bytes.length) throw validationError("Truncated instruction arguments");
    result.push({ opcode, arguments: bytesToHex(bytes.slice(cursor, cursor + length)) });
    cursor += length;
  }
  return result;
};

export const assertAllowedProgram = (program: Hex, routerKind: "aquaAmm" | "aquaLimit"): void => {
  const instructions = decodeProgram(program);
  const allowed = routerKind === "aquaLimit"
    ? new Set<number>(Object.values(LIMIT_OPCODES))
    : new Set<number>(Array.from({ length: 34 }, (_, index) => index + 1));
  for (const item of instructions) {
    if (!allowed.has(item.opcode)) throw validationError(`Opcode ${String(item.opcode)} is not allowed for ${routerKind}`);
  }
};

export const parseProgramHex = (value: string): Hex => hexSchema.parse(value);
