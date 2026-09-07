// Dev-only hooks so the shielded library can be exercised from a headless browser without a
// wallet (tests drive `window.__shield` with the testnet demo keys). Not included in builds.
import * as chain from "./chain";
import * as notes from "./notes";
import { poseidon } from "./poseidon";

if (import.meta.env.DEV) {
  (window as unknown as { __shield: unknown }).__shield = { ...chain, ...notes, poseidon };
}
