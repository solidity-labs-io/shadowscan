// Single source of truth for the API base URL. Default points at the
// production scanner so the site works against live data even when served
// locally (e.g. `python3 -m http.server`). To point at a local scanner,
// set this to "http://localhost:8080".
window.API_BASE = "https://api.shadowscan.xyz";

// Public RPCs used by the detail page for live chain introspection.
// Tried in order with failover. Update by hand if a URL changes.
// Keys must match the chain_id values the scanner reports in /api/chains
// (and the keys in CHAIN_META in app.js).
window.CHAIN_RPCS = {
  // Ethereum mainnet
  1: [
    "https://eth.llamarpc.com",
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://1rpc.io/eth"
  ],
  // Optimism
  10: [
    "https://optimism.llamarpc.com",
    "https://optimism-rpc.publicnode.com",
    "https://optimism.drpc.org"
  ],
  // Polygon
  137: [
    "https://polygon.llamarpc.com",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org"
  ],
  // Base
  8453: [
    "https://base.llamarpc.com",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://1rpc.io/base",
    "https://mainnet.base.org"
  ],
  // Arbitrum One
  42161: [
    "https://arbitrum.llamarpc.com",
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arbitrum.drpc.org"
  ]
};
