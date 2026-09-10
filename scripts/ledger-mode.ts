export const LEDGER_MODES = ["emulator", "physical"] as const;
export type LedgerMode = (typeof LEDGER_MODES)[number];

export const LEDGER_FLAG_HELP = "--ledger emulator|physical (aliases: --dev, --prod)";

const fail = (message: string): never => {
  console.error(message);
  throw new Error(message);
};

export const parseLedgerValue = (value: string): LedgerMode => {
  if (value === "emulator" || value === "emulated" || value === "dev") return "emulator";
  if (value === "physical" || value === "prod") return "physical";
  return fail(`Ledger mode must be emulator or physical (${LEDGER_FLAG_HELP}), not ${value}`);
};

export const ledgerModeFromEnv = (env: NodeJS.ProcessEnv, fallback: LedgerMode = "physical"): LedgerMode => {
  const named = env["AQUA_LEDGER"]?.trim();
  if (named !== undefined && named.length > 0) return parseLedgerValue(named);
  if (env["AQUA_LEDGER_TRANSPORT"] === "speculos") return "emulator";
  return fallback;
};

export const parseLedgerArgv = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv = Bun.env,
  fallback: LedgerMode = "physical",
): { readonly mode: LedgerMode; readonly rest: readonly string[]; readonly explicit: boolean } => {
  const rest: string[] = [];
  let flagged: LedgerMode | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--dev") {
      if (flagged === "physical") return fail("--dev and --prod cannot be combined");
      flagged = "emulator";
      continue;
    }
    if (argument === "--prod") {
      if (flagged === "emulator") return fail("--dev and --prod cannot be combined");
      flagged = "physical";
      continue;
    }
    if (argument === "--ledger" || argument.startsWith("--ledger=")) {
      const value = argument === "--ledger" ? argv[index + 1] : argument.slice("--ledger=".length);
      if (argument === "--ledger") index += 1;
      if (value === undefined || value.length === 0) return fail(`Missing value for ${LEDGER_FLAG_HELP}`);
      const parsed = parseLedgerValue(value);
      if (flagged !== undefined && flagged !== parsed) return fail("--dev and --prod cannot be combined");
      flagged = parsed;
      continue;
    }
    rest.push(argument);
  }
  return { mode: flagged ?? ledgerModeFromEnv(env, fallback), rest, explicit: flagged !== undefined || (env["AQUA_LEDGER"]?.trim().length ?? 0) > 0 };
};

export const applyLedgerMode = (mode: LedgerMode, env: NodeJS.ProcessEnv, root = env["AQUA_ROOT"] ?? process.cwd()): LedgerMode => {
  const stateDir = env["AQUA_STATE_DIR"]?.trim() || `${root}/.data`;
  env["AQUA_LEDGER"] = mode;
  if (mode === "emulator") {
    env["AQUA_E2E"] = "1";
    env["AQUA_LEDGER_TRANSPORT"] = "speculos";
    env["AQUA_SPECULOS_URL"] ??= "http://127.0.0.1:5000";
    env["AQUA_WALLET_CLI"] ??= `${root}/test/e2e/wallet-cli-adapter.ts`;
    env["AQUA_E2E_LKRP_STATE"] ??= `${stateDir}/lkrp`;
  } else {
    env["AQUA_LEDGER_TRANSPORT"] = "node-hid";
  }
  return mode;
};

export const applyLedgerArgv = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv = Bun.env,
  fallback: LedgerMode = "physical",
): { readonly mode: LedgerMode; readonly rest: readonly string[]; readonly explicit: boolean } => {
  const parsed = parseLedgerArgv(argv, env, fallback);
  applyLedgerMode(parsed.mode, env);
  return parsed;
};
