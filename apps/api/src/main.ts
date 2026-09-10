import { createApiRuntime, runtimeManifestHash } from "./runtime.ts";

const runtime = await createApiRuntime(Bun.argv);
const server = Bun.serve(runtime.options);
console.log(JSON.stringify({ level: "info", message: "server started", url: server.url.toString(), chainId: runtime.manifest.chain.id, manifestHash: runtimeManifestHash(runtime.manifest) }));
const shutdown = async (): Promise<void> => { await server.stop(); await runtime.shutdown(); };
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
