// Key files and signing for the headless client. The private-payment key lives in
// ~/.private-xpr/<network>/<account>.json (mode 600). Chain writes are signed by the proton CLI
// keychain: the account's XPR key never enters this process.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * Run one action through the proton CLI keychain on the network's chain; returns the transaction
 * id. The proton CLI's selected chain is a shared setting, so: selection failure aborts, the
 * selection is read back and must name the expected chain before signing, and a lock under the
 * key directory serialises this client's own concurrent invocations.
 */
export function act(net, contract, name, data, actor, permission = "active") {
  const run = (args) => {
    const r = spawnSync("proton", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const text = (String(r.stdout ?? "") + "\n" + String(r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
    return { status: r.status, text };
  };
  // The lock guards the proton CLI's shared chain setting, so it lives with the user, not with the
  // key directory. Acquisition is atomic (a file created O_EXCL with the holder's pid). Recovery
  // is ownership-based, never by age: a lock whose recorded owner is not running is reclaimed by
  // renaming it aside and checking that what was renamed is the dead lock that was inspected; if
  // a fresh lock was renamed by mistake it is linked back (or its owner notices below). The
  // previous directory format (a directory holding a pid file) is recognised and reclaimed the
  // same way. Safety does not rest on recovery alone: immediately before signing, the holder
  // re-reads the lock and must still find its own pid there, otherwise it starts over.
  const lock = join(homedir(), ".privatexpr-signing.lock");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  const ownerOf = (path) => {
    try {
      const st = statSync(path);
      const text = st.isDirectory() ? readFileSync(join(path, "pid"), "utf8").trim() : readFileSync(path, "utf8").trim();
      const pid = Number(text);
      return { pid: text && Number.isInteger(pid) && pid > 0 ? pid : null, ino: st.ino, dir: st.isDirectory(), age: Date.now() - st.mtimeMs };
    } catch { return null; }
  };
  const acquire = () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return; } catch (e) { if (e.code !== "EEXIST") throw e; }
      const seen = ownerOf(lock);
      const stale = seen !== null && (seen.pid !== null ? seen.pid !== process.pid && !alive(seen.pid) : seen.age > 10_000);
      if (stale) {
        const aside = `${lock}.reclaim.${process.pid}`;
        try {
          renameSync(lock, aside);
          const got = ownerOf(aside);
          if (got && got.ino === seen.ino) rmSync(aside, { recursive: true, force: true }); // exactly the dead lock inspected
          else { try { if (!got?.dir) linkSync(aside, lock); } catch { /* a newer lock already stands; its owner re-checks before signing */ } rmSync(aside, { recursive: true, force: true }); }
        } catch { /* another waiter got there first */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error("another privatexpr invocation is holding the signing lock");
      spawnSync("sleep", ["0.2"]);
    }
  };
  const holding = () => { try { return readFileSync(lock, "utf8").trim() === String(process.pid); } catch { return false; } };
  const release = () => { if (holding()) rmSync(lock, { force: true }); };
  acquire();
  let r;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) acquire();
    let retry = false;
    try {
      const sel = run(["chain:set", net.chain]);
      if (sel.status !== 0) throw new Error(`could not select the ${net.chain} chain in the proton CLI: ${sel.text.trim().slice(0, 200)}`);
      const cur = run(["chain:get"]);
      if (cur.status !== 0 || !new RegExp(`"chain":\\s*"${net.chain}"`).test(cur.text)) throw new Error(`the proton CLI is not on the ${net.chain} chain; refusing to sign`);
      // the lock must still be ours here: a waiter that reclaimed a stale lock could have displaced this one
      if (!holding()) { if (attempt >= 5) throw new Error("could not keep the signing lock; try again"); retry = true; continue; }
      r = run(["action", contract, name, JSON.stringify(data), `${actor}@${permission}`]);
      break;
    } finally {
      run(["chain:set", "proton"]);
      if (!retry) release();
    }
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
