// Dev-only hooks so the shielded library can be exercised from a headless browser without a
// wallet (tests drive `window.__shield` with the testnet demo keys). Not included in builds.
import * as snarkjs from "snarkjs";
import * as chain from "./chain";
import { broadcast } from "../chain";
import * as notes from "./notes";
import * as backup from "./backup";
import { poseidon } from "./poseidon";

if (import.meta.env.DEV) {
  (window as unknown as { __shield: unknown }).__shield = { ...chain, ...notes, ...backup, poseidon, broadcast, verify: (vk: unknown, signals: string[], proof: unknown) => snarkjs.groth16.verify(vk, signals, proof), fullProve: (input: Record<string, unknown>) => snarkjs.groth16.fullProve(input, "/circuit/joinsplit-r4.wasm", "/circuit/joinsplit-r4_final.zkey") };
}
