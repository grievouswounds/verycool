interface LedgerRuntimeSignature { readonly r: string; readonly s: string; readonly v: number }
interface LedgerRuntimeSigned { readonly owner: string; readonly signature: LedgerRuntimeSignature }
export function ledgerAddress(): Promise<string>;
export function ledgerSignMessage(message: string): Promise<LedgerRuntimeSigned>;
export function ledgerSignTypedData(typedData: Readonly<Record<string, unknown>>): Promise<LedgerRuntimeSigned>;
