// Proving with the shipped circuit files (the same wasm and rehearsal key the app serves), and
// the spend action they produce. PRIVATEXPR_CIRCUIT_DIR overrides where the files are found.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import N from "../../circuits/lib/notes.mjs";
import { encodeInputs, encodeProof } from "../../circuits/lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "../../circuits/package.json"));
const snarkjs = require("snarkjs");
const REV = "r5";
const DIR = process.env.PRIVATEXPR_CIRCUIT_DIR ?? join(HERE, "../../dapp/public/circuit");
export const WASM = join(DIR, `joinsplit-${REV}.wasm`);
export const ZKEY = join(DIR, `joinsplit-${REV}_final.zkey`);

export function checkCircuitFiles() {
  for (const f of [WASM, ZKEY]) if (!existsSync(f)) throw new Error(`circuit file missing: ${f} (set PRIVATEXPR_CIRCUIT_DIR)`);
}

/** choose up to two notes of the token covering the amount, largest first */
export function pick(notes, tokenId, amount, fmt) {
  const same = notes.filter((n) => n.token === tokenId).sort((a, b) => (a.v > b.v ? -1 : 1));
  const chosen = [];
  let sum = 0n;
  for (const n of same) { if (sum >= amount || chosen.length === 2) break; chosen.push(n); sum += n.v; }
  if (sum < amount) throw new Error(`not enough in two notes: ${fmt(sum)} in the largest two, need ${fmt(amount)}${same.length > 2 ? " (consolidate first: pay yourself the total)" : ""}`);
  return chosen;
}

/** build, prove and return the `spend` action data for `owner` */
export async function proveSpend({ keys, tree, rootSeq, auditorPk, owner, inputs, outputs, vPub = 0n, tokenPub = 0n, to = 0n }) {
  checkCircuitFiles();
  const js = N.buildJoinSplit({ keys, tree, auditorPk, sender: N.nameToU64(owner), inputs: inputs.map((n) => ({ note: n, index: n.index })), outputs, vPub, tokenPub, to });
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(js.input, WASM, ZKEY);
  const data = {
    owner,
    proof: encodeProof(proof),
    publics: encodeInputs(N.actionPublics(js.expected)),
    amount: vPub.toString(),
    token_id: vPub > 0n ? Number(tokenPub) : 0,
    root_seq: rootSeq.toString(),
  };
  return { data, outNotes: js.outNotes, ms: Date.now() - t0 };
}
