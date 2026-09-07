import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { head as blobHead } from "@vercel/blob";
import { lockActive, readState, writeState, type Attestation } from "./_lib/state.js";
import { noteFor, verifyAttestation, attestationTransaction } from "./_lib/verify.js";

export const config = { maxDuration: 60 };

/**
 * POST { actor, permission, phase, index, inputSha256, outputSha256, contributionHash, signature }
 * The file must already be in Blob at the path issued by api/upload-token. The server re-hashes
 * it, checks the chain (input = head), verifies the signed attestation, then advances the head.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const b = (req.body ?? {}) as Record<string, string | number>;
  const actor = String(b.actor ?? ""), permission = String(b.permission ?? "active");
  const phase = Number(b.phase), index = Number(b.index);
  const inputSha = String(b.inputSha256 ?? ""), outputSha = String(b.outputSha256 ?? "").toLowerCase();
  const signature = String(b.signature ?? "");
  const contributionHash = b.contributionHash ? String(b.contributionHash) : null;
  try {
    const s = await readState();
    if (!s.head) return res.status(409).json({ error: "ceremony not started" });
    if (!lockActive(s) || s.lock!.actor !== actor) return res.status(409).json({ error: "it is not your turn (lock expired?)" });
    if (phase !== s.phase || index !== s.head.index + 1) return res.status(409).json({ error: `expected phase ${s.phase} index ${s.head.index + 1}` });
    if (inputSha !== s.head.sha256) return res.status(409).json({ error: "your input is not the current head; download again" });

    const pathname = `p${phase}/${String(index).padStart(2, "0")}-${actor}.${phase === 1 ? "ptau" : "zkey"}`;
    const meta = await blobHead(pathname).catch(() => null);
    if (!meta) return res.status(409).json({ error: `file ${pathname} not uploaded` });
    const bytes = new Uint8Array(await (await fetch(meta.url, { cache: "no-store" })).arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== outputSha) return res.status(409).json({ error: "uploaded file hash does not match your attestation" });

    const note = noteFor(phase, index, outputSha);
    const signerKey = await verifyAttestation(actor, permission, note, signature);

    const att: Attestation = {
      phase: phase as 1 | 2,
      index,
      actor,
      timestamp: new Date().toISOString(),
      input: { file: s.head.file, sha256: s.head.sha256 },
      output: { file: pathname, sha256: outputSha, url: meta.url },
      contributionHash,
      transaction: attestationTransaction(actor, permission, note),
      signature,
      signerKey,
      note,
    };
    const next = await writeState(
      { ...s, head: { file: pathname, sha256: outputSha, index, name: actor, url: meta.url }, lock: null, contributions: [...s.contributions, att] },
      s.version
    );
    res.status(200).json({ ok: true, attestation: { ...att, transaction: undefined }, head: next.head });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
