export * from "./broker.ts";
export * from "./env-broker.ts";

import type { RuntimeManifest } from "@aqua/core";
import { SecretBrokerClient, type SecretBroker } from "./broker.ts";
import { EnvKeySecretBroker } from "./env-broker.ts";

export const createSecretBroker = (manifest: RuntimeManifest): SecretBroker =>
  Bun.env["AQUA_SIGNER"]?.trim() === "env" ? new EnvKeySecretBroker(manifest) : new SecretBrokerClient(manifest.services.brokerSocket);
