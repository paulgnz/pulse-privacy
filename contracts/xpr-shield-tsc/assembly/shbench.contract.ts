import { Contract, check, print } from "proton-tsc";
import { fromBytesBE, fromU64, hex, isCanonicalBE, toBytesBE } from "./fr";
import { decompress } from "./curve";
import { hash2, poseidon, zeroAt } from "./poseidon";

/**
 * Bench and conformance harness for the field arithmetic and Poseidon (milestone S1).
 * `hash` prints Poseidon of 2 or 6 big-endian field elements; `bench` chains n Poseidon(2);
 * `insert` costs what one transfer's tree update costs: pair the two commitments, then hash up
 * 20 levels against a frontier held in memory.
 */
@contract
class ShBench extends Contract {
  @action("hash")
  hash(inputs: u8[]): void {
    const n = inputs.length / 32;
    check(n == 2 || n == 5, "2 or 5 inputs");
    const inp = new StaticArray<StaticArray<u32>>(n);
    for (let i = 0; i < n; i++) {
      check(isCanonicalBE(inputs, i * 32), "input not canonical");
      unchecked((inp[i] = fromBytesBE(inputs, i * 32)));
    }
    print(hex(toBytesBE(poseidon(inp))));
  }

  @action("bench")
  bench(n: u32): void {
    let acc = fromU64(1);
    const one = fromU64(1);
    for (let i: u32 = 0; i < n; i++) acc = hash2(acc, one);
    print(hex(toBytesBE(acc)));
  }

  @action("decomp")
  decomp(w: u8[]): void {
    check(w.length == 32, "32-byte word");
    const p = decompress(w);
    print(hex(p));
  }

  @action("insert")
  insert(cm1: u8[], cm2: u8[], index: u32): void {
    check(cm1.length == 32 && cm2.length == 32, "32-byte commitments");
    // the leaf of the pair tree is Poseidon(cm1, cm2); then 20 levels up, siblings the zero chain
    let node = hash2(fromBytesBE(cm1, 0), fromBytesBE(cm2, 0));
    let idx = index;
    for (let level = 0; level < 20; level++) {
      const z = zeroAt(level);
      if ((idx & 1) == 0) node = hash2(node, z);
      else node = hash2(z, node);
      idx >>= 1;
    }
    print(hex(toBytesBE(node)));
  }
}
