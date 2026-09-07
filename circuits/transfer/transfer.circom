pragma circom 2.1.0;

// Confidential transfer statement (pulse-privacy design doc §2.4), T2 v0.
//
// Twisted ElGamal on Baby Jubjub: pubkey P = s^-1 * H; ciphertext of v with randomness r is
// C = v*G + r*H (shared commitment) and one handle D_X = r*P_X per reader X.
// Amounts are 64-bit, encrypted as two independent 32-bit chunks (lo, hi).
//
// Proves, for a sender with secret s:
//   1. s * P_s == H                                   (secret matches the registered pubkey)
//   2. B_old_k == vold_k*G + s*Bold_D_k, k in {lo,hi}   (sender knows the plaintext of the
//                                                       balance on record; chunks may be
//                                                       un-normalised, up to 40 bits)
//   3. vold == v + vnew with v, vnew in [0, 2^64)      (no overdraft; chunks normalised)
//   4. T_k is a correct encryption of v_k under P_s, P_r, P_a with shared r_T_k
//   5. B_new_k is a correct encryption of vnew_k under P_s with fresh r_N_k
//   6. nonce, sender, receiver are bound as public inputs
//
// Public inputs (41 field elements, in this order):
//   Ps[2] Pr[2] Pa[2]
//   BoldC[2][2] BoldD[2][2]        (index 0 = lo, 1 = hi)
//   BnewC[2][2] BnewD[2][2]
//   TC[2][2] TDs[2][2] TDr[2][2] TDa[2][2]
//   nonce sender receiver

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/escalarmulfix.circom";
include "circomlib/circuits/bitify.circom";
include "generators.circom";

// scalar * point, scalar given as a field element bounded to n bits
template MulAny(n) {
    signal input e;
    signal input p[2];
    signal output out[2];
    component bits = Num2Bits(n);
    bits.in <== e;
    component m = EscalarMulAny(n);
    for (var i = 0; i < n; i++) m.e[i] <== bits.out[i];
    m.p[0] <== p[0];
    m.p[1] <== p[1];
    out[0] <== m.out[0];
    out[1] <== m.out[1];
}

// scalar * fixed base (G or H), scalar bounded to n bits
template MulFix(n, BASE) {
    signal input e;
    signal output out[2];
    component bits = Num2Bits(n);
    bits.in <== e;
    component m = EscalarMulFix(n, BASE);
    for (var i = 0; i < n; i++) m.e[i] <== bits.out[i];
    out[0] <== m.out[0];
    out[1] <== m.out[1];
}

// C = v*G + r*H
template Commit(nv, nr) {
    signal input v;
    signal input r;
    signal output out[2];
    component vg = MulFix(nv, GEN_G());
    vg.e <== v;
    component rh = MulFix(nr, GEN_H());
    rh.e <== r;
    component add = BabyAdd();
    add.x1 <== vg.out[0];
    add.y1 <== vg.out[1];
    add.x2 <== rh.out[0];
    add.y2 <== rh.out[1];
    out[0] <== add.xout;
    out[1] <== add.yout;
}

template Transfer() {
    // --- scalar sizes ---
    var NS = 251;   // secrets / randomness: < Baby Jubjub subgroup order (~2^251)
    var NV = 32;    // normalised amount chunk
    var NO = 40;    // un-normalised old-balance chunk (<= 2^8 folded credits of 2^32)

    // --- public ---
    signal input Ps[2];
    signal input Pr[2];
    signal input Pa[2];
    signal input BoldC[2][2];
    signal input BoldD[2][2];
    signal input BnewC[2][2];
    signal input BnewD[2][2];
    signal input TC[2][2];
    signal input TDs[2][2];
    signal input TDr[2][2];
    signal input TDa[2][2];
    signal input nonce;
    signal input sender;
    signal input receiver;

    // --- witness ---
    signal input s;
    signal input vold[2];
    signal input v[2];
    signal input vnew[2];
    signal input rT[2];
    signal input rN[2];

    var G[2] = GEN_G();
    var H[2] = GEN_H();

    // 1. s * Ps == H
    component sPs = MulAny(NS);
    sPs.e <== s;
    sPs.p[0] <== Ps[0];
    sPs.p[1] <== Ps[1];
    sPs.out[0] === H[0];
    sPs.out[1] === H[1];

    // 2. BoldC_k == vold_k*G + s*BoldD_k
    component voldG[2];
    component sD[2];
    component oldSum[2];
    for (var k = 0; k < 2; k++) {
        voldG[k] = MulFix(NO, G);
        voldG[k].e <== vold[k];
        sD[k] = MulAny(NS);
        sD[k].e <== s;
        sD[k].p[0] <== BoldD[k][0];
        sD[k].p[1] <== BoldD[k][1];
        oldSum[k] = BabyAdd();
        oldSum[k].x1 <== voldG[k].out[0];
        oldSum[k].y1 <== voldG[k].out[1];
        oldSum[k].x2 <== sD[k].out[0];
        oldSum[k].y2 <== sD[k].out[1];
        oldSum[k].xout === BoldC[k][0];
        oldSum[k].yout === BoldC[k][1];
    }

    // 3. balance arithmetic with range checks (bits enforced inside the MulFix/Num2Bits below
    //    for v and vnew; vold is bounded to NO bits by voldG's Num2Bits)
    vold[0] + 4294967296 * vold[1] === v[0] + 4294967296 * v[1] + vnew[0] + 4294967296 * vnew[1];

    // 4. transfer ciphertexts: TC_k = v_k*G + rT_k*H ; TDx_k = rT_k * Px
    component tC[2];
    component tDs[2];
    component tDr[2];
    component tDa[2];
    for (var k = 0; k < 2; k++) {
        tC[k] = Commit(NV, NS);
        tC[k].v <== v[k];
        tC[k].r <== rT[k];
        tC[k].out[0] === TC[k][0];
        tC[k].out[1] === TC[k][1];

        tDs[k] = MulAny(NS);
        tDs[k].e <== rT[k];
        tDs[k].p[0] <== Ps[0];
        tDs[k].p[1] <== Ps[1];
        tDs[k].out[0] === TDs[k][0];
        tDs[k].out[1] === TDs[k][1];

        tDr[k] = MulAny(NS);
        tDr[k].e <== rT[k];
        tDr[k].p[0] <== Pr[0];
        tDr[k].p[1] <== Pr[1];
        tDr[k].out[0] === TDr[k][0];
        tDr[k].out[1] === TDr[k][1];

        tDa[k] = MulAny(NS);
        tDa[k].e <== rT[k];
        tDa[k].p[0] <== Pa[0];
        tDa[k].p[1] <== Pa[1];
        tDa[k].out[0] === TDa[k][0];
        tDa[k].out[1] === TDa[k][1];
    }

    // 5. new balance ciphertexts: BnewC_k = vnew_k*G + rN_k*H ; BnewD_k = rN_k * Ps
    component nC[2];
    component nD[2];
    for (var k = 0; k < 2; k++) {
        nC[k] = Commit(NV, NS);
        nC[k].v <== vnew[k];
        nC[k].r <== rN[k];
        nC[k].out[0] === BnewC[k][0];
        nC[k].out[1] === BnewC[k][1];

        nD[k] = MulAny(NS);
        nD[k].e <== rN[k];
        nD[k].p[0] <== Ps[0];
        nD[k].p[1] <== Ps[1];
        nD[k].out[0] === BnewD[k][0];
        nD[k].out[1] === BnewD[k][1];
    }

    // 6. bind nonce / sender / receiver (trivial constraints keep them in the system)
    signal bind;
    bind <== nonce * sender;
    signal bind2;
    bind2 <== bind * receiver;
}

component main {public [Ps, Pr, Pa, BoldC, BoldD, BnewC, BnewD, TC, TDs, TDr, TDa, nonce, sender, receiver]} = Transfer();
