import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readState } from "./_lib/state.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const s = await readState();
    res.setHeader("Cache-Control", "no-store");
    // transactions are public data but bulky; keep the listing light
    res.status(200).json({ ...s, contributions: s.contributions.map(({ transaction, ...rest }) => rest) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
