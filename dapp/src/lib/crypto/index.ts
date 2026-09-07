import { CRYPTO_MODE } from "../../config";
import { mockBackend } from "./mock";
import type { CryptoBackend } from "./types";

// T2 plugs in here: `import { realBackend } from "./real"` and return it for CRYPTO_MODE === "real".
export function selectBackend(): CryptoBackend {
  if (CRYPTO_MODE === "real") {
    throw new Error("real crypto backend not available yet (T2). Run in mock mode.");
  }
  return mockBackend;
}

export * from "./types";
