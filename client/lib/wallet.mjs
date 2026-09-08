// Key files and signing for the headless client. The private-payment key lives in
// ~/.private-xpr/<network>/<account>.json (mode 600). Chain writes are signed by the proton CLI
// keychain: the account's XPR key never enters this process.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import N from "../../circuits/lib/notes.mjs";

export const KEY_DIR = process.env.PRIVATEXPR_HOME ?? join(homedir(), ".private-xpr");

export function keyPath(network, account) {
  return join(KEY_DIR, network, `${account}.json`);
}
export function loadKey(network, account) {
  const p = keyPath(network, account);
  if (!existsSync(p)) throw new Error(`no key for ${account} on ${network}: run \`keys new ${account}\` or \`keys import ${account} <secret>\``);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return N.keygen(BigInt(j.secret));
}
export function saveKey(network, account, ask, meta = {}) {
  const dir = join(KEY_DIR, network);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = keyPath(network, account);
  if (existsSync(p)) throw new Error(`${p} exists; remove it first if you really want to replace the key`);
  writeFileSync(p, JSON.stringify({ format: "pulse-privacy/shieldkey/v1", account, network: `xpr-${network}`, secret: "0x" + N.hex32(ask), ...meta, warning: "Anyone with this secret can read your notes. Spending still needs your wallet." }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}
export function parseSecret(input) {
  let t = input.trim();
  if (existsSync(t)) t = readFileSync(t, "utf8").trim();
  if (t.startsWith("{")) t = String(JSON.parse(t).secret ?? "");
  t = t.replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new Error("a secret is 64 hexadecimal characters, or a key file");
  return BigInt("0x" + t);
}

/**
 * Run one action through the proton CLI keychain on the network's chain; resolves to the
 * transaction id. The proton CLI's selected chain is one shared setting for the whole user, so
 * the select-sign-restore sequence runs under an OS-managed exclusive lock (flock on
 * ~/.privatexpr-signing.lock, held by a small helper process for the duration): two signers
 * can never interleave, and a signer that dies releases the lock with its process, so nothing
 * is ever reclaimed and no displaced process exists to touch the shared setting.
 */
export async function act(net, contract, name, data, actor, permission = "active") {
  const run = (args) => {
    const r = spawnSync("proton", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const text = (String(r.stdout ?? "") + "\n" + String(r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
    return { status: r.status, text };
  };
  const lockPath = join(homedir(), ".privatexpr-signing.lock");
  // an earlier client version used a directory here; it cannot be flocked, and no earlier version is running after an upgrade
  try { if (statSync(lockPath).isDirectory()) rmSync(lockPath, { recursive: true, force: true }); } catch { /* absent */ }
  const holder = await holdLock(lockPath, 60_000);
  let r;
  try {
    const sel = run(["chain:set", net.chain]);
    if (sel.status !== 0) throw new Error(`could not select the ${net.chain} chain in the proton CLI: ${sel.text.trim().slice(0, 200)}`);
    const cur = run(["chain:get"]);
    if (cur.status !== 0 || !new RegExp(`"chain":\\s*"${net.chain}"`).test(cur.text)) throw new Error(`the proton CLI is not on the ${net.chain} chain; refusing to sign`);
    r = run(["action", contract, name, JSON.stringify(data), `${actor}@${permission}`]);
  } finally {
    run(["chain:set", "proton"]);
    holder.release();
  }
  if (process.env.PRIVATEXPR_DEBUG) console.error(r.text);
  const id = (r.text.match(/"transaction_id":\s*"([0-9a-f]{64})"/) || r.text.match(/tx\/([0-9a-f]{64})/) || [])[1];
  if (r.status !== 0 || !id) {
    const line = r.text.split("\n").filter((l) => /error|assert|failure|hint|missing|expired|exceeded|insufficient/i.test(l)).join(" | ").slice(0, 500);
    throw new Error(`${contract}::${name} did not go through: ${line || r.text.trim().slice(0, 300) || "no output from the proton CLI"}`);
  }
  const cpu = (r.text.match(/"cpu_usage_us":\s*(\d+)/) || [])[1];
  return { id, cpu: cpu ? Number(cpu) : undefined };
}

/**
 * An exclusive OS lock (flock) on `path`, held by a helper process until `release()` closes its
 * stdin, or until this process dies (the pipe closes and the helper exits). Python's fcntl is
 * used when available, else perl's flock; both are standard on macOS and Linux.
 */
function holdLock(path, timeoutMs) {
  const py = ["python3", ["-c", `import fcntl,sys,time,os\nf=open(sys.argv[1],'a+')\nt=time.time()\nwhile True:\n try:\n  fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);break\n except OSError:\n  if time.time()-t>float(sys.argv[2]): print('timeout',flush=True); sys.exit(2)\n  time.sleep(0.1)\nprint('locked',flush=True)\nsys.stdin.read()`, path, String(timeoutMs / 1000)]];
  const pl = ["perl", ["-e", `use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; my $t=time; while (!flock($f, LOCK_EX|LOCK_NB)) { if (time-$t > $ARGV[1]) { print "timeout\n"; exit 2 } select(undef,undef,undef,0.1) } $|=1; print "locked\n"; <STDIN>;`, path, String(Math.ceil(timeoutMs / 1000))]];
  return new Promise((resolve, reject) => {
    const tryWith = (cands) => {
      if (!cands.length) return reject(new Error("no lock helper found (python3 or perl is needed for signing)"));
      const [cmd, args] = cands[0];
      let child;
      try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { return tryWith(cands.slice(1)); }
      let out = "";
      let settled = false;
      child.on("error", () => { if (!settled) { settled = true; tryWith(cands.slice(1)); } });
      child.stdout.on("data", (d) => {
        out += String(d);
        if (settled) return;
        if (out.includes("locked")) { settled = true; resolve({ release: () => { try { child.stdin.end(); } catch { /* gone */ } } }); }
        else if (out.includes("timeout")) { settled = true; reject(new Error("another privatexpr invocation is holding the signing lock")); }
      });
      child.on("exit", (code) => { if (!settled) { settled = true; if (code === 127) tryWith(cands.slice(1)); else reject(new Error("the lock helper exited before taking the lock")); } });
    };
    tryWith([py, pl]);
  });
}
