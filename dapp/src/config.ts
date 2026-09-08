// Network selection: VITE_NETWORK=testnet (default) | mainnet. `xprconf` runs the confidential
// token (contracts/xpr-conf-tsc). A mainnet deployment needs the real ceremony (docs §2.8) first.
type Net = {
  chainId: string;
  endpoints: string[];
  /** Hyperion history endpoints, tried in order (failover) */
  hyperions: string[];
  contract: string;
  explorer: string;
};
const NETWORKS: Record<"testnet" | "mainnet", Net> = {
  testnet: {
    chainId: "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd",
    endpoints: ["https://tn1.protonnz.com", "https://testnet.protonchain.com", "https://test.proton.eosusa.io"],
    // the only testnet Hyperion found live and at head; add more here when they exist
    hyperions: ["https://test.proton.eosusa.io"],
    contract: "xprconf",
    explorer: "https://testnet.explorer.xprnetwork.org",
  },
  mainnet: {
    chainId: "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0",
    // v5 nodes only; greymass (v3.1) was measured at 15 s per get_block and rejects sends at 30 ms
    endpoints: ["https://api.protonnz.com", "https://proton.eosusa.io", "https://proton.cryptolions.io", "https://proton.eoscafeblock.com", "https://proton.genereos.io"],
    hyperions: ["https://hyperion-xpr-mainnet.protonnz.com", "https://proton.eosusa.io"],
    contract: "xprconf", // placeholder: the mainnet contract account is not created yet
    explorer: "https://explorer.xprnetwork.org",
  },
};
export const NETWORK: "testnet" | "mainnet" = (import.meta.env.VITE_NETWORK as "mainnet") === "mainnet" ? "mainnet" : "testnet";
const NET = NETWORKS[NETWORK];

export const CHAIN_ID = NET.chainId;
export const ENDPOINTS = NET.endpoints;
export const HYPERIONS = NET.hyperions;
/** first Hyperion (kept for callers that want one); reads use `HYPERIONS` with failover */
export const HYPERION = NET.hyperions[0];
export const CONTRACT = NET.contract;
export const EXPLORER = NET.explorer;
/** one site per network; the shielded page lives at /shielded on it */
const SITES = { mainnet: "https://private.protonnz.com/", testnet: "https://testnet.private.protonnz.com/" };
/** the other network's site, for the switch in the top bar */
export const OTHER_NETWORK = NETWORK === "mainnet" ? { label: "Testnet", url: SITES.testnet } : { label: "Mainnet", url: SITES.mainnet };
/** "XPR Network testnet" | "XPR Network" for copy */
export const NETWORK_LABEL = NETWORK === "mainnet" ? "XPR Network" : "XPR Network testnet";
export const APP_NAME = "Private XPR";

/** The shielded contract (docs/06 §8): testnet only for now. The sender's wallet signs every spend. */
// (PATHS below: where each product lives on this network's site)
export const SHIELD = NETWORK === "testnet"
  ? { enabled: true, contract: "xprshield", auditorPk: "2496233cca7c277d1e86aa8ffa6e25032580ff53a8a37f867fc045114a70e32c0f9d825b40b4bcc7b53a4f8fe1e0a10b6f00980b3510051d8b78ba72fdb2beaa" }
  : { enabled: false, contract: "privatexpr", auditorPk: "" }; // mainnet: enabled at v2 launch (docs/07); pin the committee's key here then
// `auditorPk` is the committee's public key as this build knows it: a node that reports another
// key cannot make the app seal a recovery copy to it, nor open the auditor page with it.

/** "real" (default) proves in the browser and broadcasts to the contract; VITE_CRYPTO=mock simulates. */
export const CRYPTO_MODE: "mock" | "real" = (import.meta.env.VITE_CRYPTO as "mock" | "real") === "mock" ? "mock" : "real";

/**
 * Where each product lives. Where the shielded contract is enabled it is the product: home page,
 * How it works; the confidential contract becomes "the old contract" at /old, withdraw-only
 * (docs/06 §8.5). Elsewhere the confidential statement is home and shielded is not served.
 */
export const SHIELD_HOME = SHIELD.enabled;
/** deposits into the confidential contract are closed everywhere (caps set to one unit on chain, 2026-09-08); withdrawals stay open */
export const CONF_DEPOSITS_CLOSED = true;
export const PATHS = SHIELD_HOME
  ? { shielded: "/", shieldedAbout: "/about", conf: "/old", confAbout: "/old/about" }
  : { shielded: "/shielded", shieldedAbout: "/shielded/about", conf: "/", confAbout: "/about" };
