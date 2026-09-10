import { createFacilitatorRoutes } from "../../facilitator/src/main.ts";
import { createApiRuntime } from "./runtime.ts";

const runtime = await createApiRuntime(Bun.argv);
const facilitatorRoutes = await createFacilitatorRoutes(runtime.manifest, runtime.broker);
Object.assign(runtime.options, {
  routes: {
    ...runtime.options.routes,
    ...Object.fromEntries(Object.entries(facilitatorRoutes).map(([path, handler]) => [`/facilitator${path}`, handler])),
  },
});
Bun.serve(runtime.options);
