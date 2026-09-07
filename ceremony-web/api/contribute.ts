import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { head as blobHead } from "@vercel/blob";
import { lockActive, readState, writeState, type Attestation } from "./_lib/state.js";
import { noteFor, verifyAttestation, attestationTransaction } from "./_lib/verify.js";
import { extendsChain, fetchToTmp, ptauContributions, verifyFile, zkeyContributions } from "./_lib/chain.js";

export const config = { maxDuration: 300, memory: 3009 };

/**
 * POST { actor, permission, phase, index, inputSha256, outputSha256, signature }
 * The file must already be in Blob at the path issued by api/upload-token. The server re-hashes
 * it, checks that it carries every earlier contribution unchanged plus exactly one new one,
 * runs snarkjs's verification against the ceremony start, verifies the signed attestation,
 * then advances the head. The contribution hash is read from the file, never from the client.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const b = (req.body ?? {}) as Record<string, string | number>;
  const actor = String(b.actor ?? ""), permission = String(b.permission ?? "active");
  const phase = Number(b.phase), index = Number(b.index);
  const inputSha = String(b.inputSha256 ?? ""), outputSha = String(b.outputSha256 ?? "").toLowerCase();
  const signature = String(b.signature ?? "");
  try {
    const s = await readState();
    if (!s.head) return res.status(409).json({ error: "ceremony not started" });
    if (!lockActive(s) || s.lock!.actor !== actor) return res.status(409).json({ error: "it is not your turn (lock expired?)" });
    if (phase !== s.phase || index !== s.head.index + 1) return res.status(409).json({ error: `expected phase ${s.phase} index ${s.head.index + 1}` });
    if (inputSha !== s.head.sha256) return res.status(409).json({ error: "your input is not the current head; download again" });

    const ext = phase === 1 ? "ptau" : "zkey";
    const pathname = `p${phase}/${String(index).padStart(2, "0")}-${actor}.${ext}`;
    const meta = await blobHead(pathname).catch(() => null);
    if (!meta) return res.status(409).json({ error: `file ${pathname} not uploaded` });
    const outPath = await fetchToTmp(meta.url, `out.${ext}`);
    const actual = createHash("sha256").update(new Uint8Array(readFileSync(outPath))).digest("hex");
    if (actual !== outputSha) return res.status(409).json({ error: "uploaded file hash does not match your attestation" });

    // the file must extend the head by exactly one contribution
    const headPath = await fetchToTmp(s.head.url, `head.${ext}`);
    const read = phase === 1 ? ptauContributions : zkeyContributions;
    const chain = extendsChain(await read(headPath), await read(outPath));
    if (!chain.ok) return res.status(409).json({ error: `rejected: ${chain.reason}` });

    // and verify with snarkjs against the ceremony start
    let valid: boolean;
    if (phase === 1) {
      valid = await verifyFile(1, outPath);
    } else {
      const first = s.contributions.find((c) => c.phase === 2);
      const initFile = first ? first.input.file : s.head.file;
      const initMeta = await blobHead(initFile);
      if (!s.phase1Final) return res.status(500).json({ error: "phase-1 result missing from state" });
      const initPath = await fetchToTmp(initMeta.url, "init.zkey");
      const ptauPath = await fetchToTmp(s.phase1Final.url, "final.ptau");
      valid = await verifyFile(2, outPath, initPath, ptauPath);
    }
    if (!valid) return res.status(409).json({ error: "rejected: the uploaded file does not verify" });

    const note = noteFor(phase, index, outputSha);
    const signerKey = await verifyAttestation(actor, permission, note, signature);

    const att: Attestation = {
      phase: phase as 1 | 2,
      index,
      actor,
      timestamp: new Date().toISOString(),
      input: { file: s.head.file, sha256: s.head.sha256 },
      output: { file: pathname, sha256: outputSha, url: meta.url },
      contributionHash: chain.added!.hash,
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
