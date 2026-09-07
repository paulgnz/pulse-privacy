// XPR Network testnet. `xprconf` runs the confidential token (contracts/xpr-conf-tsc). The dapp
// never talks to mainnet; a mainnet deployment needs the real ceremony (docs §2.8) first.
export const CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
export const ENDPOINTS = ["https://tn1.protonnz.com", "https://testnet.protonchain.com", "https://test.proton.eosusa.io"];
/** Hyperion history (the only testnet indexer that is live and at head) */
export const HYPERION = "https://test.proton.eosusa.io";
/** "4,XPR" as the contract's symbol raw (precision low byte, code above): scope of `accounts` */
export const SYM_RAW = "1380997124";
export const CONTRACT = "xprconf";
export const TOKEN_CONTRACT = "eosio.token";
export const SYMBOL = "XPR";
export const PRECISION = 4;
export const EXPLORER = "https://testnet.explorer.xprnetwork.org";
export const APP_NAME = "Confidential XPR";

/** "real" (default) proves in the browser and broadcasts to xprconf; VITE_CRYPTO=mock simulates. */
export const CRYPTO_MODE: "mock" | "real" = (import.meta.env.VITE_CRYPTO as "mock" | "real") === "mock" ? "mock" : "real";
