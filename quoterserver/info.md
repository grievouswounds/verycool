Structure:

GET /price/address/:chainId/:address — direct Spot Price API call
GET /price/name/:chainId/:name — Token API search (/token/v1.4/{chainId}/search) to resolve name/symbol → address, then Spot Price API lookup
Both accept ?currency=USD (defaults to USD, configurable in .env)
Centralized error handling that passes through upstream 1inch status codes
Address/chainId validation before hitting the network


Here are ready-to-run curl commands for both endpoints, assuming the server's running locally on port 3000.

By address (Ethereum mainnet, 1INCH token):

bash
curl "http://localhost:3000/price/address/1/0x111111111117dc0aa78b770fa6a738034120c302"

By name/symbol (Ethereum mainnet):

bash
curl "http://localhost:3000/price/name/1/1inch"

Other well-known tokens to try:

bash
# USDC by address (Ethereum)
curl "http://localhost:3000/price/address/1/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

# WETH by name (Ethereum)
curl "http://localhost:3000/price/name/1/weth"

# USDC by name on Polygon (chainId 137)
curl "http://localhost:3000/price/name/137/usdc"




Implemented a live Aqua trade endpoint: POST /trade.
It:
- Accepts an encoded Aqua SwapVM order plus token/amount inputs.
- Fetches an on-chain quote and enforces minAmountOut.
- Simulates the final swap before broadcasting it.
- Signs with WALLET_PRIVATE_KEY via RPC_URL.