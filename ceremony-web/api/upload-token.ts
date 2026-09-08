import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual } from "node:crypto";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { lockActive, readState } from "./_lib/state.js";
import { contributionPath } from "../shared/files.js";

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
        const { actor, token, outputSha256 } = JSON.parse(clientPayload ?? "{}") as { actor?: string; token?: string; outputSha256?: string };
        const s = await readState();
        if (!actor || !lockActive(s) || s.lock!.actor !== actor) throw new Error("it is not your turn");
        // the lock token was handed only to the holder's browser: anyone else could otherwise clear the upload in progress
        const a = new Uint8Array(Buffer.from(createHash("sha256").update(String(token ?? "")).digest("hex")));
        const c = new Uint8Array(Buffer.from(s.lock!.tokenHash ?? ""));
        if (!token || a.length !== c.length || !timingSafeEqual(a, c)) throw new Error("missing or wrong lock token");
        const index = (s.head?.index ?? 0) + 1;
        const expected = contributionPath(s.phase, index, actor, outputSha256 ?? "");
        if (pathname !== expected) throw new Error(`upload path must be ${expected}`);
        const recorded = s.contributions.some((c) => c.output.file === pathname) || s.head?.file === pathname;
        if (recorded) throw new Error("that file is already part of the transcript");
        // Never delete here: a concurrent verification may already have recorded this file.
        // A different contribution has a different path; an existing file stays immutable.
        return {
          allowedContentTypes: ["application/octet-stream"],
          maximumSizeInBytes: 80 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: false,
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
