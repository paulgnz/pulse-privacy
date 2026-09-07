// Reads the contribution records inside a .ptau or .zkey and runs snarkjs's own verification.
// A contribution is only accepted when its file carries every earlier contribution unchanged
// plus exactly one new one, and verifies against the ceremony start (review finding: without
// this, the last contributor could restart from the initial file and hold all the randomness).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as snarkjsNs from "snarkjs";
// the CJS build arrives as a default export under some loaders, the ESM build as a namespace
const snarkjs = ((snarkjsNs as unknown as { default?: unknown }).default ?? snarkjsNs) as {
  powersOfTau: { verify: (f: string, l: unknown) => Promise<boolean> };
  zKey: { verifyFromInit: (i: string, p: string, z: string, l: unknown) => Promise<boolean> };
};

export interface ContributionRecord {
  name: string;
  /** 0 = contribution, 1 = beacon */
  type: number;
  /** hex hash that identifies the contribution (ptau: next challenge; zkey: transcript) */
  hash: string;
}

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

// snarkjs's package exports hide its src/ modules; import them by file path instead
const snarkRoot = () => {
  const r = typeof require === "function" ? require : createRequire(import.meta.url);
  return join(dirname(r.resolve("snarkjs")), "..");
};
const load = (rel: string) => import(pathToFileURL(join(snarkRoot(), rel)).href);

export async function ptauContributions(file: string): Promise<ContributionRecord[]> {
  const bin = await import("@iden3/binfileutils");
  const ptu = await load("src/powersoftau_utils.js");
  const { fd, sections } = await bin.readBinFile(file, "ptau", 1);
  try {
    const { curve } = await ptu.readPTauHeader(fd, sections);
    const cs = (await ptu.readContributions(fd, curve, sections)) as { name?: string; type?: number; nextChallenge: Uint8Array }[];
    if (curve.terminate) await curve.terminate();
    return cs.map((c) => ({ name: c.name ?? "", type: c.type ?? 0, hash: hex(c.nextChallenge) }));
  } finally {
    await fd.close();
  }
}

export async function zkeyContributions(file: string): Promise<ContributionRecord[]> {
  const bin = await import("@iden3/binfileutils");
  const zku = await load("src/zkey_utils.js");
  const { fd, sections } = await bin.readBinFile(file, "zkey", 2);
  try {
    const zk = await zku.readHeader(fd, sections, false);
    const mpc = (await zku.readMPCParams(fd, zk.curve, sections)) as { contributions: { name?: string; type?: number; transcript: Uint8Array }[] };
    if (zk.curve.terminate) await zk.curve.terminate();
    return mpc.contributions.map((c) => ({ name: c.name ?? "", type: c.type ?? 0, hash: hex(c.transcript) }));
  } finally {
    await fd.close();
  }
}

/** true when `next` is `prev` plus exactly one new contribution, earlier records untouched */
export function extendsChain(prev: ContributionRecord[], next: ContributionRecord[]): { ok: boolean; reason?: string; added?: ContributionRecord } {
  if (next.length !== prev.length + 1) return { ok: false, reason: `expected ${prev.length + 1} contributions in the file, found ${next.length}` };
  for (let i = 0; i < prev.length; i++) if (prev[i].hash !== next[i].hash) return { ok: false, reason: `contribution ${i + 1} in the uploaded file differs from the current head` };
  return { ok: true, added: next[next.length - 1] };
}

/** snarkjs's full verification: phase 1 against the initial powers, phase 2 against the setup zkey */
export async function verifyFile(phase: 1 | 2, file: string, init?: string, ptau?: string): Promise<boolean> {
  const quiet = { info() {}, debug() {}, warn() {}, error() {}, log() {} };
  if (phase === 1) return (await snarkjs.powersOfTau.verify(file, quiet)) === true;
  if (!init || !ptau) throw new Error("phase 2 verification needs the setup zkey and the final ptau");
  return (await snarkjs.zKey.verifyFromInit(init, ptau, file, quiet)) === true;
}

/** download a blob to a temp file (snarkjs reads from disk); a fresh upload can take a few seconds to appear at its public address */
export async function fetchToTmp(url: string, name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ceremony-"));
  let res: Response | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    res = await fetch(url, { cache: "no-store" });
    if (res.ok) break;
    if (res.status !== 404 && res.status !== 403) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res || !res.ok) throw new Error(`download ${name}: HTTP ${res?.status ?? "no response"}`);
  const p = join(dir, name);
  writeFileSync(p, new Uint8Array(await res.arrayBuffer()));
  return p;
}
