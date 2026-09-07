import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { collectMotion, osRandomHex } from "./lib/entropy";
import { sha256Hex } from "./lib/hash";
import { lockNoteFor, login, noteFor, signAttestation, type Session } from "./lib/wallet";

interface Head { file: string; sha256: string; index: number; name: string; url: string }
interface Contribution { phase: 1 | 2; index: number; actor: string; timestamp: string; input: { file: string; sha256: string }; output: { file: string; sha256: string; url: string }; contributionHash: string | null; signerKey: string; note: string; signature: string }
interface State { version: number; phase: 1 | 2; finished: boolean; head: Head | null; lock: { actor: string; until: string } | null; contributions: Contribution[]; phase1Final?: Head | null; updatedAt: string }

type Step = "idle" | "locking" | "downloading" | "entropy" | "computing" | "sign" | "signing" | "uploading" | "recording" | "done";
const AFTER_SIGN: Step[] = ["uploading", "recording"];
const AFTER_COMPUTE: Step[] = ["sign", "signing", ...AFTER_SIGN];

const short = (h: string, n = 12) => (h ? h.slice(0, n) + "…" : "");
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [stateErr, setStateErr] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [motion, setMotion] = useState(0);
  const [sentence, setSentence] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ index: number; phase: number; sha256: string; contributionHash: string | null; file: string } | null>(null);
  const [turn, setTurn] = useState<{ index: number; head: Head; phase: 1 | 2 } | null>(null);
  const sentenceReady = useRef<((s: string) => void) | null>(null);
  const timer = useRef<number | null>(null);
  // the finished contribution, held until the user clicks to sign: the wallet popup is only
  // allowed inside a click, and the mixing step ends minutes after the last one
  const ready = useRef<{ out: Uint8Array; outputSha: string; inputSha: string; phase: 1 | 2; index: number; contributionHash: string | null } | null>(null);
  const [slow, setSlow] = useState(false);
  const lockToken = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "signing") { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [step]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error(`state ${r.status}`);
      setState((await r.json()) as State);
      setStateErr(null);
    } catch (e) {
      setStateErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    login(true).then((s) => s && setSession(s)).catch(() => {});
  }, []);

  const connect = async () => {
    setErr(null);
    try {
      const s = await login(false);
      if (s) setSession(s);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const contribute = async () => {
    if (!session || !state?.head) return;
    const actor = session.auth.actor;
    setErr(null);
    setResult(null);
    setLog([]);
    try {
      // 1. take the turn: signed by your account (from this click), so nobody can take it for you
      setStep("locking");
      const ts = Date.now();
      const lockSig = await signAttestation(session, lockNoteFor(state.phase, (state.head.index ?? 0) + 1, ts));
      const lr = await fetch("/api/lock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor, permission: session.auth.permission, ts, signature: lockSig }) });
      const lj = (await lr.json()) as { error?: string; head?: Head; phase?: 1 | 2; index?: number; token?: string };
      if (!lr.ok) throw new Error(lj.error ?? "could not take a turn");
      lockToken.current = lj.token ?? null;
      const head = lj.head!, phase = lj.phase!, index = lj.index!;
      setTurn({ index, head, phase });

      // 2. download the current file
      setStep("downloading");
      const fr = await fetch(head.url, { cache: "no-store" });
      if (!fr.ok) throw new Error("could not download the current file");
      const input = new Uint8Array(await fr.arrayBuffer());
      const inputSha = await sha256Hex(input);
      if (inputSha !== head.sha256) throw new Error("downloaded file does not match the published hash; refresh and try again");

      // 3. randomness: OS + motion + sentence
      setStep("entropy");
      setMotion(0);
      const motionSamples = await collectMotion(10, setMotion);
      const typed = await new Promise<string>((resolve) => { sentenceReady.current = resolve; });
      const entropy = osRandomHex(64) + "|" + motionSamples + "|" + typed;

      // 4. contribute in a worker
      setStep("computing");
      setElapsed(0);
      const t0 = Date.now();
      timer.current = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
      const out = await new Promise<{ out: Uint8Array; contributionHash: string | null }>((resolve, reject) => {
        const w = new Worker(new URL("./worker.ts", import.meta.url));
        w.onmessage = (ev) => {
          const m = ev.data as { type: string; msg?: string; out?: Uint8Array; contributionHash?: string | null };
          if (m.type === "log" && m.msg) setLog((l) => [...l.slice(-8), m.msg!]);
          else if (m.type === "done") { resolve({ out: m.out!, contributionHash: m.contributionHash ?? null }); w.terminate(); }
          else if (m.type === "error") { reject(new Error(m.msg)); w.terminate(); }
        };
        w.onerror = (e) => { reject(new Error(e.message)); w.terminate(); };
        w.postMessage({ phase, data: input, name: `${actor} (browser)`, entropy }, [input.buffer]);
      });
      if (timer.current) clearInterval(timer.current);
      const outputSha = await sha256Hex(out.out);

      // 5. hand over to a click: the attestation signature needs the wallet popup
      ready.current = { out: out.out, outputSha, inputSha, phase, index, contributionHash: out.contributionHash };
      setStep("sign");
    } catch (e) {
      fail(e as Error, actor);
    }
  };

  const fail = (e: Error, actor: string) => {
    if (timer.current) clearInterval(timer.current);
    setErr(e.message);
    setStep("idle");
    ready.current = null;
    // give the turn back if we hold it
    if (lockToken.current) fetch("/api/lock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor, release: true, token: lockToken.current }) }).catch(() => {});
    lockToken.current = null;
    refresh();
  };

  /** from a click: sign the attestation (never broadcast), then upload and record */
  const signAndFinish = async () => {
    const r = ready.current;
    if (!session || !r) return;
    const actor = session.auth.actor;
    const { out, outputSha, inputSha, phase, index } = r;
    setErr(null);
    setStep("signing");
    let signature: string;
    try {
      signature = await signAttestation(session, noteFor(phase, index, outputSha));
    } catch (e) {
      // not signed: keep the finished file and let the user click again
      setErr(`Not signed. ${(e as Error).message}`);
      setStep("sign");
      return;
    }
    try {
      // 6. upload straight to storage, then record
      setStep("uploading");
      const pathname = `p${phase}/${String(index).padStart(2, "0")}-${actor}.${phase === 1 ? "ptau" : "zkey"}`;
      await upload(pathname, new Blob([out as BlobPart], { type: "application/octet-stream" }), {
        access: "public",
        handleUploadUrl: "/api/upload-token",
        multipart: true,
        contentType: "application/octet-stream",
        clientPayload: JSON.stringify({ actor }),
      });
      setStep("recording");
      const cr = await fetch("/api/contribute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor, permission: session.auth.permission, phase, index, inputSha256: inputSha, outputSha256: outputSha, contributionHash: ready.current?.contributionHash ?? null, signature }),
      });
      const cj = (await cr.json()) as { error?: string; attestation?: { contributionHash?: string | null } };
      if (!cr.ok) throw new Error(cj.error ?? "the coordinator rejected the contribution");
      setResult({ index, phase, sha256: outputSha, contributionHash: cj.attestation?.contributionHash ?? ready.current?.contributionHash ?? null, file: pathname });
      lockToken.current = null;
      ready.current = null;
      setStep("done");
      refresh();
    } catch (e) {
      fail(e as Error, actor);
    }
  };

  const lockHeld = state?.lock && Date.parse(state.lock.until) > Date.now() ? state.lock : null;
  const mine = session?.auth.actor;
  const alreadyDone = !!(state && mine && state.contributions.some((c) => c.phase === state.phase && c.actor === mine));
  const canStart = !!session && !!state?.head && !state.finished && step === "idle" && (!lockHeld || lockHeld.actor === mine) && !alreadyDone;

  return (
    <main className="page">
      <header className="top">
        <div className="brand">Confidential XPR</div>
        <div className="muted">Trusted setup ceremony</div>
      </header>

      <section>
        <h1>Help make the proving key that no one can forge</h1>
        <p>
          Every private transfer on Confidential XPR carries a small proof. The key those proofs are checked against is built from a random secret,
          and whoever knew that secret could forge proofs. So the key is built by many people in turn: each adds their own randomness and throws it
          away. To forge a proof you would need everyone's randomness. As long as one person really threw theirs away, nobody can.
        </p>
        <p>
          Your turn takes a couple of minutes and happens entirely in your browser. Your randomness never leaves your machine. What gets recorded is
          your account name, the hash of the file you produced, and a signature from your XPR account saying you produced it. Nothing is sent to the
          chain.
        </p>
      </section>

      <section className="status">
        <h2>Right now</h2>
        {stateErr ? <p className="error">Could not reach the coordinator: {stateErr}</p> : null}
        {state ? (
          <dl className="facts">
            <div><dt>Phase</dt><dd>{state.phase === 1 ? "1 of 2, universal setup" : "2 of 2, transfer circuit"}{state.finished ? ", closed" : ""}</dd></div>
            <div><dt>Contributions so far</dt><dd>{state.contributions.filter((c) => c.phase === state.phase).length}</dd></div>
            <div><dt>Current file</dt><dd>{state.head ? <>{state.head.file} <span className="mono">{short(state.head.sha256, 16)}</span></> : "not started"}</dd></div>
            <div><dt>Whose turn</dt><dd>{lockHeld ? `${lockHeld.actor}, until ${when(lockHeld.until)}` : "free"}</dd></div>
          </dl>
        ) : (
          <p className="muted">Loading</p>
        )}
      </section>

      <section className="contribute">
        <h2>Contribute</h2>
        {!session ? (
          <div className="row">
            <button className="btn" onClick={connect}>Connect wallet</button>
            <span className="muted">XPR Network mainnet, WebAuth. Your wallet only signs a message; it never sends a transaction.</span>
          </div>
        ) : (
          <p>Signed in as <b>{session.auth.actor}</b>.{alreadyDone ? " You have already contributed to this phase. Thank you." : ""}</p>
        )}
        {err ? <p className="error">{err}</p> : null}

        {session && step === "idle" && !alreadyDone ? (
          <div className="row">
            <button className="btn private" onClick={contribute} disabled={!canStart}>Take my turn</button>
            {lockHeld && lockHeld.actor !== mine ? <span className="muted">It is {lockHeld.actor}'s turn until {when(lockHeld.until)}. Try again after that.</span> : null}
            {state?.finished ? <span className="muted">This phase is closed.</span> : null}
          </div>
        ) : null}

        {step !== "idle" && step !== "done" ? (
          <ol className="steps">
            <li className={step === "locking" ? "now" : "done"}>Taking your turn{turn ? `: contribution ${turn.index} of phase ${turn.phase}` : ""}{step === "locking" ? " (sign in your wallet to claim it)" : ""}</li>
            <li className={step === "downloading" ? "now" : ["entropy", "computing", ...AFTER_COMPUTE].includes(step) ? "done" : ""}>Downloading the current file ({turn?.phase === 1 ? "about 36 MB" : "about 25 MB"})</li>
            <li className={step === "entropy" ? "now" : ["computing", ...AFTER_COMPUTE].includes(step) ? "done" : ""}>
              Adding your randomness
              {step === "entropy" ? (
                <div className="entropy">
                  <p>Move your mouse or finger around for ten seconds.</p>
                  <div className="bar"><i style={{ width: `${Math.round(motion * 100)}%` }} /></div>
                  {motion >= 1 ? (
                    <div className="row">
                      <input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="Now type a long random sentence" autoFocus />
                      <button className="btn" disabled={sentence.length < 12} onClick={() => { sentenceReady.current?.(sentence); setSentence(""); }}>Continue</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
            <li className={step === "computing" ? "now" : AFTER_COMPUTE.includes(step) ? "done" : ""}>
              Mixing it into the key in your browser{step === "computing" ? ` (${elapsed}s; phase 1 can take a few minutes)` : ""}
              {step === "computing" && log.length ? <pre className="log">{log.join("\n")}</pre> : null}
            </li>
            <li className={step === "sign" || step === "signing" ? "now" : AFTER_SIGN.includes(step) ? "done" : ""}>
              Signing your attestation in the wallet (one signature, nothing is sent to the chain)
              {step === "sign" ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn private" onClick={signAndFinish}>Sign the attestation</button>
                  <span className="muted">Your file is ready. This opens your wallet.</span>
                </div>
              ) : null}
              {step === "signing" && slow ? (
                <p className="muted" style={{ marginTop: 10 }}>
                  Still waiting? Your browser may have blocked the wallet popup. Allow popups for {location.host}, then{" "}
                  <button className="link" onClick={() => setStep("sign")}>try again</button>. On a phone, approve the request in the WebAuth app and come back to this tab.
                </p>
              ) : null}
            </li>
            <li className={step === "uploading" ? "now" : step === "recording" ? "done" : ""}>Uploading your file</li>
            <li className={step === "recording" ? "now" : ""}>Recording your contribution</li>
          </ol>
        ) : null}

        {step === "done" && result ? (
          <div className="done">
            <h3>Done. Thank you.</h3>
            <p>Your contribution is number {result.index} of phase {result.phase}. Please post this somewhere public that you control, so anyone can check the transcript against it:</p>
            <pre className="publish">{JSON.stringify({ ceremony: "Confidential XPR", phase: result.phase, index: result.index, account: mine, file: result.file, sha256: result.sha256, contribution_hash: result.contributionHash }, null, 2)}</pre>
            <p className="muted">Close this tab afterwards. Nothing on your machine needs to be kept.</p>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Transcript</h2>
        {state && state.contributions.length ? (
          <table className="ledger">
            <thead><tr><th>#</th><th>Phase</th><th>Account</th><th>When</th><th>Output</th><th>Signed by</th></tr></thead>
            <tbody>
              {state.contributions.map((c) => (
                <tr key={`${c.phase}-${c.index}`}>
                  <td>{c.index}</td>
                  <td>{c.phase}</td>
                  <td>{c.actor}</td>
                  <td>{when(c.timestamp)}</td>
                  <td><a href={c.output.url}>{c.output.file}</a> <span className="mono">{short(c.output.sha256, 16)}</span></td>
                  <td className="mono">{short(c.signerKey, 18)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No contributions yet.</p>
        )}
      </section>

      <section>
        <h2>Verify it yourself</h2>
        <p>Every file and attestation above is public. From a checkout of the repository:</p>
        <pre className="publish">{`cd ceremony && npm install
# download the files listed above into contributions/ and final/, then:
node verify.mjs`}</pre>
        <p className="muted">
          Finalisation (the random beacon from an announced XPR block, and the verifying key) is done by the coordinator with the command-line tools and
          published here when complete.
        </p>
      </section>

      <footer className="foot">Confidential XPR ceremony. Coordinator: protonnz. Contract xprconf on XPR Network.</footer>
    </main>
  );
}
