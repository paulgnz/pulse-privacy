// Proving with the shipped circuit files (the same wasm and rehearsal key the app serves), and
// the spend action they produce. PRIVATEXPR_CIRCUIT_DIR overrides where the files are found.
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import N from "../../circuits/lib/notes.mjs";
import { encodeInputs, encodeProof } from "../../circuits/lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "../../circuits/package.json"));
const snarkjs = require("snarkjs");
const REV = "r6";
const DIR = process.env.PRIVATEXPR_CIRCUIT_DIR ?? join(HERE, "../../dapp/public/circuit");
export const WASM = join(DIR, `joinsplit-${REV}.wasm`);
export const ZKEY = join(DIR, `joinsplit-${REV}_final.zkey`);

export function checkCircuitFiles() {
  for (const f of [WASM, ZKEY]) if (!existsSync(f)) throw new Error(`circuit file missing: ${f} (set PRIVATEXPR_CIRCUIT_DIR)`);
}

/** choose up to two notes of the token covering the amount, largest first, within one tree (one root per proof) */
export function pick(notes, tokenId, amount, fmt, trees) {
  const byTree = new Map();
  for (const n of notes) if (n.token === tokenId) { const id = N.treeOf(n.index); byTree.set(id, [...(byTree.get(id) ?? []), n]); }
  const sum = (ns) => ns.reduce((s, n) => s + n.v, 0n);
  const order = [...byTree.entries()].sort((a, b) => (sum(b[1]) > sum(a[1]) ? 1 : -1));
  const total = sum([...byTree.values()].flat());
  if (total < amount) throw new Error(`not enough: ${fmt(total)} available, need ${fmt(amount)}`);
  for (const [id, same0] of order) {
    const tree = trees.get(id);
    if (!tree) continue;
    const same = same0.sort((a, b) => (a.v > b.v ? -1 : 1));
    const chosen = [];
    let got = 0n;
    for (const n of same) { if (got >= amount || chosen.length === 2) break; chosen.push(n); got += n.v; }
    if (got >= amount) return { inputs: chosen, tree };
  }
  // no tree pays with two notes, though the balance covers the amount
  const covering = order.find(([, ns]) => sum(ns) >= amount);
  if (covering) throw new Error(`the amount is spread over more than two notes in tree ${covering[0]} (a payment spends at most two): pay yourself the total first, two notes at a time`);
  throw new Error("the amount spans notes in more than one tree (a payment spends from one): pay yourself what is in each tree, two notes at a time; the change lands in the current tree");
}

/** build, prove and return the `spend` action data for `owner` */
export async function proveSpend({ keys, tree, auditorPk, owner, inputs, outputs, vPub = 0n, tokenPub = 0n, to = 0n }) {
  const rootSeq = tree.rootSeq;
  checkCircuitFiles();
  // the two outputs go on chain in random order, so position does not say which is the change
  const ordered = randomInt(2) ? [outputs[1], outputs[0]] : outputs;
  const js = N.buildJoinSplit({ keys, tree, auditorPk, sender: N.nameToU64(owner), inputs: inputs.map((n) => ({ note: n, index: n.index })), outputs: ordered, vPub, tokenPub, to });
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
