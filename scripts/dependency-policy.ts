import { z } from "zod";

const packageSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).loose();

const packageJson = packageSchema.parse(await Bun.file("package.json").json());
const directNames = [...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})];
const lock = await Bun.file("aube-lock.yaml").text();
const directForbidden = ["viem", "ethers", "web3", "@1inch/aqua-sdk", "@1inch/swap-vm-sdk"] as const;
const transitivelyForbidden = ["ethers", "web3", "@1inch/aqua-sdk", "@1inch/swap-vm-sdk"] as const;
const found = [
  ...directForbidden.filter((name) => directNames.includes(name)),
  ...transitivelyForbidden.filter((name) => lock.includes(`/${name}@`) || lock.includes(`${name}:`)),
];

if (await Bun.file("quoterserver/package.json").exists()) {
  console.error("standalone quoterserver package must not be restored; use packages/quoter");
  process.exit(1);
}

if (found.length > 0) {
  console.error(`prohibited dependencies: ${found.join(", ")}`);
  process.exit(1);
}

for (const name of ["@x402/core", "@x402/evm", "@x402/mcp"] as const) {
  if (packageJson.dependencies?.[name] !== "2.25.0") {
    console.error(`${name} must remain exactly pinned to audited integration version 2.25.0`);
    process.exit(1);
  }
}

console.log("dependency policy: passed");
