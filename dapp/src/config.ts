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
    endpoints: ["https://proton.greymass.com", "https://proton.eosusa.io"],
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
/** "4,XPR" as the contract's symbol raw (precision low byte, code above): scope of `accounts` */
export const SYM_RAW = "1380997124";
export const CONTRACT = NET.contract;
export const TOKEN_CONTRACT = "eosio.token";
export const SYMBOL = "XPR";
export const PRECISION = 4;
export const EXPLORER = NET.explorer;
/** the other network's site, for the switch in the top bar */
export const OTHER_NETWORK = NETWORK === "mainnet"
  ? { label: "Testnet", url: "https://testnet.private.protonnz.com/" }
  : { label: "Mainnet", url: "https://private.protonnz.com/" };
/** "XPR Network testnet" | "XPR Network" for copy */
export const NETWORK_LABEL = NETWORK === "mainnet" ? "XPR Network" : "XPR Network testnet";
export const APP_NAME = "Confidential XPR";

/** "real" (default) proves in the browser and broadcasts to the contract; VITE_CRYPTO=mock simulates. */
export const CRYPTO_MODE: "mock" | "real" = (import.meta.env.VITE_CRYPTO as "mock" | "real") === "mock" ? "mock" : "real";
