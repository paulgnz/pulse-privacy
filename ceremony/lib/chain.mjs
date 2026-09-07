// Contribution records inside .ptau / .zkey files, read through snarkjs's own parsers.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve("snarkjs")), "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const hex = (u8) => Buffer.from(u8).toString("hex");

export async function ptauContributions(file) {
  const bin = await import("@iden3/binfileutils");
  const ptu = await load("src/powersoftau_utils.js");
  const { fd, sections } = await bin.readBinFile(file, "ptau", 1);
  try {
    const { curve } = await ptu.readPTauHeader(fd, sections);
    const cs = await ptu.readContributions(fd, curve, sections);
    if (curve.terminate) await curve.terminate();
    return cs.map((c) => ({ name: c.name ?? "", type: c.type ?? 0, hash: hex(c.nextChallenge) }));
  } finally {
    await fd.close();
  }
}

export async function zkeyContributions(file) {
  const bin = await import("@iden3/binfileutils");
  const zku = await load("src/zkey_utils.js");
  const { fd, sections } = await bin.readBinFile(file, "zkey", 2);
  try {
    const zk = await zku.readHeader(fd, sections, false);
    const mpc = await zku.readMPCParams(fd, zk.curve, sections);
    if (zk.curve.terminate) await zk.curve.terminate();
    return mpc.contributions.map((c) => ({ name: c.name ?? "", type: c.type ?? 0, hash: hex(c.transcript) }));
  } finally {
    await fd.close();
  }
}

/** `next` must be `prev` plus exactly one contribution, earlier records untouched */
export function extendsChain(prev, next) {
  if (next.length !== prev.length + 1) return { ok: false, reason: `expected ${prev.length + 1} contributions, found ${next.length}` };
  for (let i = 0; i < prev.length; i++) if (prev[i].hash !== next[i].hash) return { ok: false, reason: `contribution ${i + 1} differs from the previous file` };
  return { ok: true, added: next[next.length - 1] };
}

export const RPCS = ["https://api.protonnz.com", "https://proton.eosusa.io", "https://proton.cryptolions.io"];

/** the block id at `height` from every RPC; they must agree and the id must encode the height */
export async function beaconId(height) {
  const ids = [];
  for (const rpc of RPCS) {
    try {
      const r = await (await fetch(`${rpc}/v1/chain/get_block`, { method: "POST", body: JSON.stringify({ block_num_or_id: height }), signal: AbortSignal.timeout(15000) })).json();
      if (r.id) ids.push({ rpc, id: r.id, timestamp: r.timestamp });
    } catch (e) {
      console.warn(`beacon: ${rpc} failed: ${e.message}`);
    }
  }
  if (ids.length < 2) throw new Error("fewer than two RPCs answered for the beacon block");
  if (new Set(ids.map((x) => x.id)).size !== 1) throw new Error(`RPCs disagree on block ${height}: ${ids.map((x) => `${x.rpc} ${x.id}`).join(", ")}`);
  const id = ids[0].id;
  if (parseInt(id.slice(0, 8), 16) !== height) throw new Error(`block id ${id} does not encode height ${height}`);
  return { id, timestamp: ids[0].timestamp, sources: ids.map((x) => x.rpc) };
}
