import "./json-bigint.mjs";
import { DeviceActionStatus, DeviceManagementKitBuilder, DeviceModelId, UserInteractionRequired } from "@ledgerhq/device-management-kit";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { nodeHidTransportFactory } from "@ledgerhq/device-transport-kit-node-hid";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { filter, firstValueFrom, tap, timeout } from "rxjs";

const derivationPath = "44'/60'/0'/0/0";
const deviceTimeoutMs = 60_000;
const prompts = {
  [UserInteractionRequired.UnlockDevice]: "Unlock your Ledger and enter its PIN.",
  [UserInteractionRequired.ConfirmOpenApp]: "Confirm opening the Ethereum app on your Ledger.",
  [UserInteractionRequired.VerifyAddress]: "Verify the Ethereum owner address on your Ledger.",
  [UserInteractionRequired.SignPersonalMessage]: "Review and sign the SIWE message on your Ledger.",
  [UserInteractionRequired.SignTypedData]: "Review and sign the delegation policy on your Ledger.",
};
const runAction = async (action) => {
  const state = await firstValueFrom(action.observable.pipe(
    tap((value) => { if (value.status === DeviceActionStatus.Pending) { const prompt = prompts[value.intermediateValue.requiredUserInteraction]; if (prompt) console.error(prompt); } }),
    filter((value) => value.status === DeviceActionStatus.Completed || value.status === DeviceActionStatus.Error || value.status === DeviceActionStatus.Stopped),
    timeout(deviceTimeoutMs),
  ));
  if (state.status === DeviceActionStatus.Error) {
    const error = state.error;
    const code = error !== null && typeof error === "object" && "errorCode" in error ? String(error.errorCode) : "";
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    throw new Error(`Ledger device action failed: ${message}${code.length > 0 ? ` (${code})` : ""}`);
  }
  if (state.status === DeviceActionStatus.Stopped) throw new Error("Ledger operation was cancelled");
  return state.output;
};
const withLedger = async (operation) => {
  const requestedTransport = process.env.AQUA_LEDGER_TRANSPORT ?? "node-hid";
  if (requestedTransport !== "node-hid" && requestedTransport !== "speculos") throw new Error("AQUA_LEDGER_TRANSPORT must be node-hid or speculos");
  if (requestedTransport === "speculos" && process.env.AQUA_E2E !== "1") throw new Error("Speculos transport is restricted to AQUA_E2E=1");
  const transportFactory = requestedTransport === "speculos"
    ? speculosTransportFactory(process.env.AQUA_SPECULOS_URL ?? "http://127.0.0.1:5000", true, DeviceModelId.NANO_SP)
    : nodeHidTransportFactory;
  const dmk = new DeviceManagementKitBuilder().addTransport(transportFactory).build();
  console.error(requestedTransport === "speculos" ? "Connecting to the E2E Speculos Ledger." : "Connect and unlock the Ledger owner device.");
  const devices = await firstValueFrom(dmk.listenToAvailableDevices({}).pipe(filter((items) => items.length > 0), timeout(deviceTimeoutMs)));
  if (!devices[0]) throw new Error("No Ledger device is available");
  const sessionId = await dmk.connect({
    device: devices[0],
    sessionRefresherOptions: { isRefresherDisabled: requestedTransport === "speculos", pollingInterval: 3000 },
  });
  const stop = new AbortController();
  const speculosUrl = process.env.AQUA_SPECULOS_URL ?? "http://127.0.0.1:5000";
  const masher = requestedTransport === "speculos" ? mashSpeculos(speculosUrl, stop.signal) : Promise.resolve();
  try {
    const signer = new SignerEthBuilder({ dmk, sessionId }).build();
    const { address } = await runAction(signer.getAddress(derivationPath, { checkOnDevice: false }));
    return await operation(signer, address);
  } finally { stop.abort(); await masher; await dmk.disconnect({ sessionId }); await dmk.close(); }
};
export const ledgerAddress = () => withLedger((_signer, owner) => owner);
export const ledgerSignMessage = (message) => withLedger(async (signer, owner) => ({ owner, signature: await runAction(signer.signMessage(derivationPath, message)) }));
const asTypedData = (value) => {
  if (typeof value !== "object" || value === null) throw new Error("Ledger typed data is missing");
  const record = value;
  const domain = record.domain;
  const types = record.types;
  const primaryType = record.primaryType;
  const message = record.message;
  if (typeof domain !== "object" || domain === null || typeof types !== "object" || types === null || typeof primaryType !== "string" || typeof message !== "object" || message === null) {
    throw new Error("Ledger typed data is missing domain, types, primaryType, or message");
  }
  const chainId = domain.chainId;
  return {
    domain: {
      name: domain.name, version: domain.version, verifyingContract: domain.verifyingContract,
      chainId: typeof chainId === "string" ? Number(chainId) : chainId,
    },
    types, primaryType, message,
  };
};
const requestedTransportOf = () => process.env.AQUA_LEDGER_TRANSPORT ?? "node-hid";
const speculosText = async (url) => {
  const body = await (await fetch(`${url}/events?currentscreenonly=true`)).json();
  const events = Array.isArray(body.events) ? body.events : [];
  return events.map((event) => String(event.text ?? "").trim()).filter((line) => line.length > 0).join("\n");
};
const mashSpeculos = async (url, signal) => {
  const press = async (button) => {
    await fetch(`${url}/button/${button}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }),
    });
  };
  let last = "";
  while (!signal.aborted) {
    try {
      const text = await speculosText(url);
      if (text !== last) { console.error(`Speculos screen:\n${text}`); last = text; }
      const lowered = text.toLowerCase();
      const idle = lowered.length === 0 || lowered.includes("is ready") || lowered.includes("quit") || lowered === "ethereum"
        || lowered.includes("app settings")
        || (lowered.includes("blind signing") && /(?:enabled|disabled)/u.test(lowered) && !lowered.includes("must"));
      if (!idle) {
        const confirm = /hold to sign|hold to approve|hold to|accept risk|both buttons|approve|sign typed/.test(lowered)
          || (/\bsign message\b/.test(lowered) && !/typed data/.test(lowered));
        await press(confirm ? "both" : "right");
      }
    } catch { /* Speculos may be between screens. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
export const ledgerSignTypedData = (typedData) => withLedger(async (signer, owner) => {
  try {
    return { owner, signature: await runAction(signer.signTypedData(derivationPath, asTypedData(typedData))) };
  } catch (error) {
    if (requestedTransportOf() === "speculos") {
      const url = process.env.AQUA_SPECULOS_URL ?? "http://127.0.0.1:5000";
      try { console.error(`Speculos screen after typed-data failure: ${await speculosText(url)}`); }
      catch { /* Speculos may already have exited. */ }
    }
    throw error;
  }
});
