/* global console */
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
  if (state.status === DeviceActionStatus.Error) throw state.error;
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
  try {
    const signer = new SignerEthBuilder({ dmk, sessionId }).build();
    const { address } = await runAction(signer.getAddress(derivationPath, { checkOnDevice: false }));
    return await operation(signer, address);
  } finally { await dmk.disconnect({ sessionId }); await dmk.close(); }
};
export const ledgerAddress = () => withLedger((_signer, owner) => owner);
export const ledgerSignMessage = (message) => withLedger(async (signer, owner) => ({ owner, signature: await runAction(signer.signMessage(derivationPath, message)) }));
export const ledgerSignTypedData = (typedData) => withLedger(async (signer, owner) => ({ owner, signature: await runAction(signer.signTypedData(derivationPath, typedData)) }));
