import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lockActive, readState, writeState } from "./_lib/state.js";
import { lockNoteFor, verifyAttestation } from "./_lib/verify.js";

const LOCK_MINUTES = 20;
const NAME_RE = /^[a-z1-5.]{1,12}$/;
const SKEW_MS = 5 * 60_000;

/**
 * POST { actor, permission, ts, signature } → take the turn (20 min). The signature is the
 * account's over the never-broadcast viewkey note `ceremony/lock/<phase>/<index>/<ts>`, so
 * only the account itself can take its turn. Returns a lock token; the same token releases it:
 * POST { actor, release: true, token }.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const b = (req.body ?? {}) as { actor?: string; permission?: string; ts?: number; signature?: string; release?: boolean; token?: string };
  const actor = b.actor ?? "";
  if (!NAME_RE.test(actor)) return res.status(400).json({ error: "actor required" });
  try {
    const s = await readState();
    if (s.finished || !s.head) return res.status(409).json({ error: "the ceremony is not accepting contributions right now" });
    if (b.release) {
      if (s.lock?.actor !== actor) return res.status(409).json({ error: "not your lock" });
      const a = new Uint8Array(Buffer.from(createHash("sha256").update(String(b.token ?? "")).digest("hex"))), c = new Uint8Array(Buffer.from(s.lock.tokenHash ?? ""));
      if (!a.length || a.length !== c.length || !timingSafeEqual(a, c)) return res.status(403).json({ error: "wrong lock token" });
      const next = await writeState({ ...s, lock: null }, s.version);
      return res.status(200).json({ ok: true, state: { ...next, lock: null } });
    }
    // Replaying the same signed request must not rotate an active holder's secret token.
    if (lockActive(s)) return res.status(409).json({ error: `it is ${s.lock!.actor}'s turn until ${s.lock!.until}`, lock: { actor: s.lock!.actor, until: s.lock!.until } });
    if (s.contributions.some((c) => c.phase === s.phase && c.actor === actor)) return res.status(409).json({ error: `${actor} already contributed to phase ${s.phase}` });
    const ts = Number(b.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_MS) return res.status(400).json({ error: "stale request; try again" });
    const index = s.head.index + 1;
    await verifyAttestation(actor, b.permission ?? "active", lockNoteFor(s.phase, index, ts), String(b.signature ?? ""));
    const token = randomBytes(16).toString("hex");
    const until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
    const next = await writeState({ ...s, lock: { actor, until, tokenHash: createHash("sha256").update(token).digest("hex") } }, s.version);
    res.status(200).json({ ok: true, token, lock: { actor, until }, head: next.head, phase: next.phase, index });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
