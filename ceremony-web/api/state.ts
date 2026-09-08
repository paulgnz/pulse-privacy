import type { VercelRequest, VercelResponse } from "@vercel/node";
import { lastKnownState, readState } from "./_lib/state.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const s = await readState();
    // transactions are public data but bulky; keep the listing light. The lock's token hash is
    // public too (the state files are), but the listing has no use for it
    res.status(200).json({ ...s, lock: s.lock ? { actor: s.lock.actor, until: s.lock.until } : null, contributions: s.contributions.map(({ transaction, ...rest }) => rest) });
  } catch (e) {
    // a listing only: the last state this instance read, marked stale, so the page keeps showing
    // whose turn it is instead of an error; every write still reads the store afresh
    const last = lastKnownState();
    if (last) return res.status(200).json({ ...last, lock: last.lock ? { actor: last.lock.actor, until: last.lock.until } : null, contributions: last.contributions.map(({ transaction, ...rest }) => rest), stale: (e as Error).message });
    res.status(500).json({ error: (e as Error).message });
  }
}
