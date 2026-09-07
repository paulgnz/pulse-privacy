import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { lockActive, readState } from "./_lib/state.js";

/**
 * Issues a client upload token for the lock holder's output file only. A file that has been
 * recorded as the head can never be overwritten; a failed attempt may be retried until then.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const body = req.body as HandleUploadBody;
    const out = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const { actor } = JSON.parse(clientPayload ?? "{}") as { actor?: string };
        const s = await readState();
        if (!actor || !lockActive(s) || s.lock!.actor !== actor) throw new Error("it is not your turn");
        const index = (s.head?.index ?? 0) + 1;
        const expected = `p${s.phase}/${String(index).padStart(2, "0")}-${actor}.${s.phase === 1 ? "ptau" : "zkey"}`;
        if (pathname !== expected) throw new Error(`upload path must be ${expected}`);
        const recorded = s.contributions.some((c) => c.output.file === pathname) || s.head?.file === pathname;
        if (recorded) throw new Error("that file is already part of the transcript");
        return {
          allowedContentTypes: ["application/octet-stream"],
          maximumSizeInBytes: 80 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: true, // retries before the file is recorded; refused above once it is
          validUntil: Date.now() + 25 * 60_000,
          tokenPayload: JSON.stringify({ actor, pathname }),
        };
      },
      onUploadCompleted: async () => {
        /* the attestation POST (api/contribute) advances the head; nothing to do here */
      },
    });
    res.status(200).json(out);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
