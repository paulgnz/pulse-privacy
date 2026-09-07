import { Contract, U256, print } from "proton-tsc";
import { Pt, onCurve, add, hexOf } from "./babyjub";
import { P_BE } from "./consts";

// debug-only: print intermediate field values to compare against JS
@contract
class BjDbg extends Contract {
  @action("dbg")
  dbg(x: u8[], y: u8[]): void {
    const p = U256.fromBytesBE(P_BE);
    const a = U256.fromBytesBE(x);
    const b = U256.fromBytesBE(y);
    print("p=" + hexOf(p) + "\n");
    print("a=" + hexOf(a) + "\n");
    print("sum=" + hexOf(a + b) + "\n");
    print("shr=" + hexOf(a >> 1) + "\n");
    print("and=" + hexOf(a & U256.One) + "\n");
    const P = new Pt(a, b);
    print("oncurve=" + (onCurve(P) ? "1" : "0") + "\n");
    const D = add(P, P);
    print("dbl=" + hexOf(D.x) + "," + hexOf(D.y) + "\n");
  }
}
