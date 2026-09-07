// Classic worker: runs the snarkjs contribution off the main thread.
declare const snarkjs: any;
declare function importScripts(...urls: string[]): void;
importScripts("/snarkjs.min.js");

type Req = { phase: 1 | 2; data: Uint8Array; name: string; entropy: string };
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
const logger = {
  debug: (m: string) => post({ type: "log", level: "debug", msg: String(m) }),
  info: (m: string) => post({ type: "log", level: "info", msg: String(m) }),
  warn: (m: string) => post({ type: "log", level: "warn", msg: String(m) }),
  error: (m: string) => post({ type: "log", level: "error", msg: String(m) }),
};
const toHex = (a: Uint8Array) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { phase, data, name, entropy } = ev.data;
  try {
    const input = { type: "mem", data };
    const output: { type: string; data?: Uint8Array } = { type: "mem" };
    const t0 = performance.now();
    let hash: unknown;
    if (phase === 1) hash = await snarkjs.powersOfTau.contribute(input, output, name, entropy, logger);
    else hash = await snarkjs.zKey.contribute(input, output, name, entropy, logger);
    const out = output.data;
    if (!out) throw new Error("no output produced");
    const contributionHash = hash instanceof Uint8Array ? toHex(hash) : typeof hash === "string" ? hash : null;
    (self as unknown as Worker).postMessage({ type: "done", out, contributionHash, seconds: Math.round((performance.now() - t0) / 1000) }, [out.buffer]);
  } catch (e) {
    post({ type: "error", msg: (e as Error).message ?? String(e) });
  }
};
