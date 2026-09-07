#!/usr/bin/env node
// Coordinator: seed phase 1 (or set a new head). Reads BLOB_READ_WRITE_TOKEN from .env.local.
//   node scripts/seed.mjs start [path/to/00-start.ptau]   # creates one with snarkjs if missing
//   node scripts/seed.mjs head <localfile> <pathname> <phase> [name]   # e.g. phase-2 setup zkey
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const f of [".env.local", ".env"]) if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error("BLOB_READ_WRITE_TOKEN missing (vercel env pull .env.local)"); process.exit(1); }
const { put, list } = await import("@vercel/blob");

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
async function writeState(next) {
  const { blobs } = await list({ prefix: "state/", limit: 1000 });
  let prev = { version: 0, contributions: [], phase: 1, finished: false, head: null, lock: null };
  if (blobs.length) { const latest = blobs.map((b) => b.pathname).sort().at(-1); prev = await (await fetch(blobs.find((b) => b.pathname === latest).url, { cache: "no-store" })).json(); }
  const version = prev.version + 1;
  const state = { ...prev, ...next, version, updatedAt: new Date().toISOString() };
  const name = `state/${String(version).padStart(6, "0")}-${state.updatedAt.replace(/[:.]/g, "-")}.json`;
  await put(name, JSON.stringify(state, null, 2), { access: "public", addRandomSuffix: false, contentType: "application/json" });
  return state;
}

const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === "start") {
  let file = a;
  if (!file || !existsSync(file)) {
    const dir = mkdtempSync(join(tmpdir(), "ptau-"));
    file = join(dir, "00-start.ptau");
    console.log("creating a fresh 2^16 powers-of-tau start file (no secret yet)…");
    execSync(`npx snarkjs powersoftau new bn128 16 ${file}`, { stdio: "inherit" });
  }
  const bytes = readFileSync(file);
  const pathname = "p1/00-start.ptau";
  const r = await put(pathname, bytes, { access: "public", addRandomSuffix: false, contentType: "application/octet-stream" });
  const s = await writeState({ phase: 1, finished: false, lock: null, head: { file: pathname, sha256: sha256(bytes), index: 0, name: "coordinator start (no secret)", url: r.url } });
  console.log("seeded phase 1:", s.head);
} else if (cmd === "head") {
  const bytes = readFileSync(a);
  const r = await put(b, bytes, { access: "public", addRandomSuffix: false, contentType: "application/octet-stream" });
  const phase = Number(c) === 2 ? 2 : 1;
  const s = await writeState({ phase, finished: false, lock: null, head: { file: b, sha256: sha256(bytes), index: 0, name: d ?? "coordinator", url: r.url } });
  console.log("head set:", s.head, "phase", phase);
} else {
  console.log("usage: seed.mjs start [file] | head <localfile> <pathname> <phase> [name]");
}
