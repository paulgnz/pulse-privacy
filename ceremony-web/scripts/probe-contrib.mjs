import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve("snarkjs")), "..");
const bin = await import("@iden3/binfileutils");
const ptu = await import(pathToFileURL(join(root, "src/powersoftau_utils.js")).href);
const zku = await import(pathToFileURL(join(root, "src/zkey_utils.js")).href);
const hex = (u8) => Buffer.from(u8).toString("hex");
{
  const { fd, sections } = await bin.readBinFile(process.argv[2], "ptau", 1);
  const { curve, power } = await ptu.readPTauHeader(fd, sections);
  const cs = await ptu.readContributions(fd, curve, sections);
  console.log("ptau power", power, "contributions", cs.map((c) => ({ id: c.id, name: c.name, type: c.type, next: hex(c.nextChallenge).slice(0, 16) })));
  await fd.close();
}
{
  const { fd, sections } = await bin.readBinFile(process.argv[3], "zkey", 2);
  const zk = await zku.readHeader(fd, sections, false);
  const mpc = await zku.readMPCParams(fd, zk.curve, sections);
  console.log("zkey contributions", mpc.contributions.map((c) => ({ name: c.name, type: c.type, t: hex(c.transcript).slice(0, 16) })), "csHash", hex(mpc.csHash).slice(0, 16));
  await fd.close();
}
