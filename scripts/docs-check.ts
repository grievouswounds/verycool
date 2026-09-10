import { openApiDocument } from "../apps/api/src/openapi.ts";
import { QUOTER_ROUTE_METHODS } from "@aqua/quoter";

const documented = Object.keys(openApiDocument["paths"] ?? {});
const serverSource = await Bun.file("apps/api/src/server.ts").text();
const missing = documented.filter((path) => {
  const nativePath = path.replaceAll(/\{([A-Za-z0-9]+)\}/gu, ":$1");
  return !serverSource.includes(JSON.stringify(nativePath)) && !(nativePath in QUOTER_ROUTE_METHODS);
});
if (missing.length > 0) {
  console.error(`OpenAPI paths missing from native routes: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`documentation synchronization: ${String(documented.length)} paths`);
