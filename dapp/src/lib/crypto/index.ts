import { CRYPTO_MODE } from "../../config";
import { mockBackend } from "./mock";
import { realBackend } from "./real";
import type { CryptoBackend } from "./types";

/** Real crypto is the default; `VITE_CRYPTO=mock` keeps the simulated pool for UI work. */
export function selectBackend(): CryptoBackend {
  return CRYPTO_MODE === "mock" ? mockBackend : realBackend;
}

export * from "./types";
