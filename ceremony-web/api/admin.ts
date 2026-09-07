import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual } from "node:crypto";
import { head as blobHead } from "@vercel/blob";
import { readState, writeState } from "./_lib/state.js";

/**
 * Coordinator operations, authorised by ADMIN_TOKEN (env).
 *  { op: "release" }                              clear the lock
 *  { op: "sethead", pathname, name, phase }        point the head at an uploaded file (start of
 *                                                  phase 1, or the phase-2 setup zkey after finalising phase 1)
 *  { op: "finish" }                                close contributions (finalisation is done with the CLI)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const token = new Uint8Array(Buffer.from(String(req.headers["x-admin-token"] ?? "")));
  const want = new Uint8Array(Buffer.from(process.env.ADMIN_TOKEN ?? ""));
  if (!want.length || token.length !== want.length || !timingSafeEqual(token, want)) return res.status(401).json({ error: "unauthorised" });
  const b = (req.body ?? {}) as Record<string, string | number>;
  try {
    const s = await readState();
    if (b.op === "release") return res.status(200).json(await writeState({ ...s, lock: null }, s.version));
    if (b.op === "finish") return res.status(200).json(await writeState({ ...s, finished: true, lock: null }, s.version));
    if (b.op === "sethead") {
      const pathname = String(b.pathname);
      const meta = await blobHead(pathname);
      const bytes = new Uint8Array(await (await fetch(meta.url, { cache: "no-store" })).arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const phase = Number(b.phase) === 2 ? 2 : 1;
      // phase 2 verifies against the prepared phase-1 result (beacon applied, prepared for phase 2),
      // which is a different file from the last contribution: it must be named explicitly
      let phase1Final = s.phase1Final;
      if (phase === 2) {
        if (!b.ptauPathname) return res.status(400).json({ error: "phase 2 needs ptauPathname (the prepared pot16_final.ptau in Blob)" });
        const pm = await blobHead(String(b.ptauPathname));
        const pb = new Uint8Array(await (await fetch(pm.url, { cache: "no-store" })).arrayBuffer());
        phase1Final = { file: String(b.ptauPathname), sha256: createHash("sha256").update(pb).digest("hex"), index: -1, name: "phase-1 final (beacon applied, prepared)", url: pm.url };
      }
      const next = await writeState({ ...s, phase, finished: false, lock: null, phase1Final, head: { file: pathname, sha256, index: 0, name: String(b.name ?? "coordinator"), url: meta.url } }, s.version);
      return res.status(200).json(next);
    }
    res.status(400).json({ error: "unknown op" });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
