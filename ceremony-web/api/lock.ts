import type { VercelRequest, VercelResponse } from "@vercel/node";
import { lockActive, readState, writeState } from "./_lib/state.js";

const LOCK_MINUTES = 20;
const NAME_RE = /^[a-z1-5.]{1,12}$/;

/** POST { actor } → take the turn (20 min). POST { actor, release: true } → release own lock. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const { actor, release } = (req.body ?? {}) as { actor?: string; release?: boolean };
  if (!actor || !NAME_RE.test(actor)) return res.status(400).json({ error: "actor required" });
  try {
    const s = await readState();
    if (s.finished || !s.head) return res.status(409).json({ error: "the ceremony is not accepting contributions right now" });
    if (release) {
      if (s.lock?.actor !== actor) return res.status(409).json({ error: "not your lock" });
      const next = await writeState({ ...s, lock: null }, s.version);
      return res.status(200).json({ ok: true, state: next });
    }
    if (lockActive(s) && s.lock!.actor !== actor) return res.status(409).json({ error: `it is ${s.lock!.actor}'s turn until ${s.lock!.until}`, lock: s.lock });
    if (s.contributions.some((c) => c.phase === s.phase && c.actor === actor)) return res.status(409).json({ error: `${actor} already contributed to phase ${s.phase}` });
    const until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
    const next = await writeState({ ...s, lock: { actor, until } }, s.version);
    res.status(200).json({ ok: true, lock: next.lock, head: next.head, phase: next.phase, index: (next.head?.index ?? 0) + 1 });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
