export const ETHEREUM_SEPOLIA_CHAIN_ID = 11_155_111;

export interface RpcEndpoint {
  readonly name: string;
  readonly tier: 0 | 1 | 2;
  readonly url: string;
}

/**
 * Hardcoded Ethereum Sepolia registry. Chain 31337 is absent so local Anvil
 * becomes a single-endpoint pool from the manifest URL.
 *
 * Excluded on purpose:
 * - all `wss://` entries: RpcPort is request/response only
 * - https://xrpc.cl/sepolia — reported height 0
 * - https://eth-sepolia.g.alchemy.com/v2/demo — shared demo key
 * - https://dapps.shardeum.org and https://sphinx.shardeum.org — Shardeum, not Sepolia
 * - Alchemy / Owlracle / 4everland URLs that embed someone else's API key
 */
const SEPOLIA: readonly RpcEndpoint[] = [
  { name: "tenderly", tier: 0, url: "https://sepolia.gateway.tenderly.co" },
  { name: "tenderly-public", tier: 0, url: "https://gateway.tenderly.co/public/sepolia" },
  { name: "drpc-lb", tier: 0, url: "https://lb.drpc.org/ogrpc?network=sepolia" },
  { name: "publicnode", tier: 1, url: "https://ethereum-sepolia-rpc.publicnode.com" },
  { name: "drpc", tier: 1, url: "https://sepolia.drpc.org" },
  { name: "blastapi", tier: 1, url: "https://eth-sepolia.public.blastapi.io" },
  { name: "1rpc", tier: 1, url: "https://1rpc.io/sepolia" },
  { name: "omniatech", tier: 1, url: "https://endpoints.omniatech.io/v1/eth/sepolia/public" },
  { name: "onfinality", tier: 1, url: "https://eth-sepolia.api.onfinality.io/public" },
  { name: "stackup", tier: 1, url: "https://public.stackup.sh/api/v1/node/ethereum-sepolia" },
  { name: "zan", tier: 1, url: "https://api.zan.top/eth-sepolia" },
  { name: "tatum", tier: 1, url: "https://ethereum-sepolia.gateway.tatum.io" },
  { name: "nodies", tier: 1, url: "https://ethereum-sepolia.nodies.app" },
  { name: "ethpandaops", tier: 1, url: "https://rpc.sepolia.ethpandaops.io" },
  { name: "routeme", tier: 1, url: "https://sepolia.rpc.routeme.pro" },
  { name: "pocket", tier: 1, url: "https://eth-sepolia.publicnode.com" },
  { name: "sentio", tier: 1, url: "https://rpc.sentio.xyz/sepolia" },
  { name: "therpc", tier: 1, url: "https://rpc.therpc.io/ethereum-sepolia" },
  { name: "0xrpc", tier: 1, url: "https://0xrpc.io/sep" },
  { name: "sepolia-org", tier: 1, url: "https://rpc.sepolia.org" },
  { name: "notadegen", tier: 1, url: "https://rpc.notadegen.com/eth/sepolia" },
  { name: "unifra", tier: 1, url: "https://rpc-sepolia.unifra.io" },
];

const REGISTRY: Readonly<Record<number, readonly RpcEndpoint[]>> = Object.freeze({
  [ETHEREUM_SEPOLIA_CHAIN_ID]: SEPOLIA,
});

export const endpointsForChain = (chainId: number): readonly RpcEndpoint[] => REGISTRY[chainId] ?? [];

export const primaryRpcUrl = (chainId: number, fallback: string): string => {
  const first = endpointsForChain(chainId)[0];
  return first === undefined ? fallback : first.url;
};

export const resolvePoolEndpoints = (chainId: number, rpcUrl: string): readonly RpcEndpoint[] => {
  const registered = endpointsForChain(chainId);
  if (registered.length > 0) return registered;
  return [{ name: "manifest", tier: 0, url: rpcUrl }];
};
