import { z } from "zod";

const packageSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).loose();

const packageJson = packageSchema.parse(await Bun.file("package.json").json());
const directNames = [...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})];
const lock = await Bun.file("aube-lock.yaml").text();
const forbidden = ["viem", "ethers", "web3", "@1inch/aqua-sdk", "@1inch/swap-vm-sdk"] as const;
const found = forbidden.filter((name) => directNames.includes(name) || lock.includes(`/${name}@`) || lock.includes(`${name}:`));

if (found.length > 0) {
  console.error(`prohibited dependencies: ${found.join(", ")}`);
  process.exit(1);
}

console.log("dependency policy: passed");
