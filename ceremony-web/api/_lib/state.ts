// Ceremony state lives in Vercel Blob as append-only versions `state/<version>-<time>.json`.
// Listing is an API call (never CDN-cached), and every version has a new URL, so reads are
// always fresh. Files: `p1/NN-actor.ptau`, `p2/NN-actor.zkey`.
import { list, put } from "@vercel/blob";

export type Phase = 1 | 2;

export interface Attestation {
  phase: Phase;
  index: number;
  actor: string;
  timestamp: string;
  input: { file: string; sha256: string };
  output: { file: string; sha256: string; url: string };
  contributionHash: string | null;
  /** the signed, never-broadcast xprconf::viewkey transaction and its signature */
  transaction: unknown;
  signature: string;
  signerKey: string;
  note: string;
}

export interface Head {
  file: string;
  sha256: string;
  index: number;
  name: string;
  url: string;
}

export interface CeremonyState {
  version: number;
  phase: Phase;
  finished: boolean;
  head: Head | null;
  /** the sha256 of a token handed only to the holder's browser; releasing needs the token (state files are public) */
  lock: { actor: string; until: string; tokenHash?: string } | null;
  contributions: Attestation[];
  /** phase-1 result, kept when phase 2 starts */
  phase1Final?: Head | null;
  updatedAt: string;
}

const EMPTY: CeremonyState = { version: 0, phase: 1, finished: false, head: null, lock: null, contributions: [], updatedAt: new Date(0).toISOString() };

export async function readState(): Promise<CeremonyState> {
  // walk every page: the newest version must never fall off the end of a single listing
  let cursor: string | undefined;
  let latest: { pathname: string; url: string } | null = null;
  do {
    const page = await list({ prefix: "state/", limit: 1000, cursor });
    for (const b of page.blobs) if (!latest || b.pathname > latest.pathname) latest = { pathname: b.pathname, url: b.url };
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (!latest) return EMPTY;
  const res = await fetch(latest.url, { cache: "no-store" });
  if (!res.ok) throw new Error(`state fetch ${res.status}`);
  return (await res.json()) as CeremonyState;
}

export async function writeState(next: Omit<CeremonyState, "version" | "updatedAt">, prevVersion: number): Promise<CeremonyState> {
  const version = prevVersion + 1;
  const state: CeremonyState = { ...next, version, updatedAt: new Date().toISOString() };
  // one fixed name per version and no overwriting: the second writer of a version fails here,
  // which is the compare-and-set the review asked for
  const name = `state/${String(version).padStart(6, "0")}.json`;
  try {
    await put(name, JSON.stringify(state, null, 2), { access: "public", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json" });
  } catch (e) {
    throw new Error(`state changed concurrently; retry (${(e as Error).message})`);
  }
  return state;
}

export const lockActive = (s: CeremonyState) => !!s.lock && Date.parse(s.lock.until) > Date.now();

export function json(res: { status: (n: number) => { json: (b: unknown) => void } }, code: number, body: unknown) {
  res.status(code).json(body);
}
