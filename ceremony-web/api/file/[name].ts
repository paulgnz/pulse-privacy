import type { VercelRequest, VercelResponse } from "@vercel/node";
import { head as blobHead } from "@vercel/blob";

/** GET /api/file/p1/03-alice.ptau → 302 to the public blob URL */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = req.query.name;
  const name = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
  if (!/^p[12]\/[0-9]{2,}-[a-z1-5.]{1,12}(?:-[0-9a-f]{64})?\.(ptau|zkey)$/.test(name) && !/^state\//.test(name)) return res.status(400).json({ error: "bad name" });
  try {
    const meta = await blobHead(name);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, meta.url);
  } catch {
    res.status(404).json({ error: "not found" });
  }
}
