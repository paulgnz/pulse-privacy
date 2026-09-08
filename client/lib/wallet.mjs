// Key files and signing for the headless client. The private-payment key lives in
// ~/.private-xpr/<network>/<account>.json (mode 600). Chain writes are signed by the proton CLI
// keychain: the account's XPR key never enters this process.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * id. The proton CLI's selected chain is one shared setting for the whole user, so the whole
 * select-sign-restore sequence is executed by a helper process that holds an OS lock (flock) for
 * exactly its own lifetime and runs the proton commands itself: the lock cannot outlive the
 * operation, nor the operation the lock, and if the helper dies no further step starts. The
 * lock path is new (never a directory), so nothing from earlier client versions is touched.
 */
export function act(net, contract, name, data, actor, permission = "active") {
  const lockPath = join(homedir(), ".privatexpr-signing.flock");
  const argv = [lockPath, net.chain, "proton", "60", contract, name, JSON.stringify(data), `${actor}@${permission}`];
  const r = runLocked(argv);
  const text = r.text.replace(/\x1b\[[0-9;]*m/g, "");
  if (process.env.PRIVATEXPR_DEBUG) console.error(text);
  if (r.status === 3) throw new Error("another privatexpr invocation is holding the signing lock");
  if (r.status === 4) throw new Error(`could not select the ${net.chain} chain in the proton CLI: ${text.trim().slice(0, 200)}`);
  if (r.status === 5) throw new Error(`the proton CLI is not on the ${net.chain} chain; refusing to sign`);
  const id = (text.match(/"transaction_id":\s*"([0-9a-f]{64})"/) || text.match(/tx\/([0-9a-f]{64})/) || [])[1];
  if (r.status !== 0 || !id) {
    const line = text.split("\n").filter((l) => /error|assert|failure|hint|missing|expired|exceeded|insufficient/i.test(l)).join(" | ").slice(0, 500);
    throw new Error(`${contract}::${name} did not go through: ${line || text.trim().slice(0, 300) || "no output from the proton CLI"}`);
  }
  const cpu = (text.match(/"cpu_usage_us":\s*(\d+)/) || [])[1];
  return { id, cpu: cpu ? Number(cpu) : undefined };
}

// The helper: take the lock (or exit 3 after the timeout), select the chain (exit 4 on failure),
// read it back (exit 5 if it is not the one asked for), run the action, and restore the default
// chain on every path. Its stdout is the action's output; its exit status is the action's, or
// one of the codes above. python3 is preferred, perl is the fallback; both are standard on
// macOS and Linux.
const PY_HELPER = `
import fcntl, subprocess, sys, time, re
lock, chain, restore, timeout = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
action = sys.argv[5:]
f = open(lock, "a+")
t = time.time()
while True:
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); break
    except OSError:
        if time.time() - t > timeout: sys.exit(3)
        time.sleep(0.1)
def run(args):
    p = subprocess.run(["proton"] + args, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + "\\n" + (p.stderr or "")
try:
    rc, out = run(["chain:set", chain])
    if rc != 0: sys.stdout.write(out); sys.exit(4)
    rc, out = run(["chain:get"])
    if rc != 0 or not re.search(r'"chain":\\s*"%s"' % re.escape(chain), out): sys.stdout.write(out); sys.exit(5)
    rc, out = run(["action"] + action)
    sys.stdout.write(out)
    sys.exit(rc)
finally:
    run(["chain:set", restore])
`;
const PL_HELPER = `
use Fcntl qw(:flock); my ($lock, $chain, $restore, $timeout, @action) = @ARGV;
open(my $f, ">>", $lock) or die; my $t = time;
while (!flock($f, LOCK_EX|LOCK_NB)) { exit 3 if time - $t > $timeout; select(undef, undef, undef, 0.1) }
sub run { my $out = qx(proton @_ 2>&1); return ($? >> 8, $out) }
my ($rc, $out);
END { qx(proton chain:set $restore 2>&1) }
($rc, $out) = run("chain:set", $chain); if ($rc) { print $out; exit 4 }
($rc, $out) = run("chain:get"); if ($rc || $out !~ /"chain":\\s*"\\Q$chain\\E"/) { print $out; exit 5 }
($rc, $out) = run("action", map { "'" . $_ . "'" } @action); print $out; exit $rc;
`;
function runLocked(argv) {
  for (const [cmd, script] of [["python3", PY_HELPER], ["perl", PL_HELPER]]) {
    const r = spawnSync(cmd, [cmd === "python3" ? "-c" : "-e", script, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    if ((r.error && r.error.code === "ENOENT") || r.status === 127) continue; // helper interpreter missing: try the next
    return { status: r.status, text: String(r.stdout ?? "") + "\n" + String(r.stderr ?? "") };
  }
  throw new Error("no lock helper found (python3 or perl is needed for signing)");
}
