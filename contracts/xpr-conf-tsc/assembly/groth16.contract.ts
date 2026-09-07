import { Contract, check, print } from "proton-tsc";
import { groth16Verify } from "./groth16";

// T1 — standalone Groth16 verifier action (deployed to testnet account `xprconf` first).
// The verifier itself lives in ./groth16.ts and is reused by the token contract.
@contract
class Groth16Verifier extends Contract {
  /** Verify a Groth16 proof; the action fails if the proof is invalid. */
  @action("verify")
  verify(vk: u8[], proof: u8[], inputs: u8[]): void {
    check(groth16Verify(vk, proof, inputs), "invalid proof");
    print("groth16: valid");
  }
}
