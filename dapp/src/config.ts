// XPR Network testnet. The contract account is the T1 verifier today and the confidential
// token (T3) later; the dapp never talks to mainnet.
export const CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
export const ENDPOINTS = ["https://tn1.protonnz.com", "https://testnet.protonchain.com"];
export const CONTRACT = "xprconf";
export const TOKEN_CONTRACT = "eosio.token";
export const SYMBOL = "XPR";
export const PRECISION = 4;
export const EXPLORER = "https://testnet.explorer.xprnetwork.org";
export const APP_NAME = "Confidential XPR";

/** "mock" runs the whole flow locally against a simulated contract; "real" broadcasts to xprconf. */
export const CRYPTO_MODE: "mock" | "real" = (import.meta.env.VITE_CRYPTO as "mock" | "real") ?? "mock";
