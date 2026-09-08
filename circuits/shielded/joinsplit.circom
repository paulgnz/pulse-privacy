pragma circom 2.1.0;

// Shielded join-split (docs/06-shielded-design.md §2.3): two input notes, two output notes.
//
// Note: (pk, v, token, r); cm = Poseidon(pk.x, pk.y, v, token, r).
// Keys: pk = ask·B8 (circomlib Base8), nk = Poseidon(ask, 0), nf = Poseidon(nk, leafIndex).
// Encryption to a point P with ephemeral esk: k = Poseidon((esk·P).x, (esk·P).y),
// c[m] = plain[m] + Poseidon(k, m).
//
// Revision 2 (docs/06 §8): the sender's wallet signs the action, so the sender's key is a
// public output the contract checks against the sender's registration, and the sender's
// account name is bound. Revision 3 trims the data: no `rho` (nullifiers use the leaf index),
// value and token packed into one word (v + token·2^64), and the auditor ciphertext carries
// the receiver key as (y, parity of x) with the parity bit at 2^72 of the packed word.
//
// Public signals, in snarkjs order (outputs first, then public inputs):
//   nf[2] cm[2] epk[2][2] cr[2][2] ca[2][3] senderPk[2]     (outputs, 20)
//   root vPub tokenPub to sender A[2]                       (public inputs, 7)
//
// Input 0 is always a real note. Input 1 may be disabled (enabled1 = 0): then it carries no
// value, is not checked against the tree, and its nullifier is a dummy in a reserved domain
// (revision 5), which the contract records like any other.
//
// Revision 4 (after review): `ask` is bound below the subgroup order, otherwise ask + k·L gives
// the same key with a different nullifier; the two inputs cannot be the same leaf; output keys
// must lie in the prime-order subgroup; the ephemeral scalar cannot be zero; the parity bit of
// the receiver key is taken from an alias-free bit decomposition.
//
// Revision 5 (privacy and hardening, before the ceremony's phase 2): a disabled second input
// still emits a nullifier, Poseidon(nk, 2^40 + dummy) with a fresh private `dummy` below 2^40,
// so the chain cannot tell a one-note payment from a two-note one (real leaf indices are below
// 2^20, so the domains never meet); and the ephemeral scalars are bound below the subgroup
// order like `ask`, so esk = k·L cannot make the ephemeral key the identity. Same 27 public
// signals as revision 4.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/compconstant.circom";

template NoteCommitment() {
    signal input pk[2];
    signal input v;
    signal input token;
    signal input r;
    signal output cm;
    component h = Poseidon(5);
    h.inputs[0] <== pk[0];
    h.inputs[1] <== pk[1];
    h.inputs[2] <== v;
    h.inputs[3] <== token;
    h.inputs[4] <== r;
    cm <== h.out;
}

// Merkle root from a leaf, its siblings and the path bits (bit = 1: leaf is on the right)
template MerkleRoot(depth) {
    signal input leaf;
    signal input siblings[depth];
    signal input bits[depth];
    signal output root;
    component h[depth];
    signal left[depth];
    signal right[depth];
    signal cur[depth + 1];
    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        bits[i] * (1 - bits[i]) === 0;
        left[i] <== cur[i] + bits[i] * (siblings[i] - cur[i]);
        right[i] <== siblings[i] + bits[i] * (cur[i] - siblings[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}

// scalar (253-bit) times an arbitrary point
template MulPoint() {
    signal input e;
    signal input p[2];
    signal output out[2];
    component bits = Num2Bits(253);
    bits.in <== e;
    component m = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) m.e[i] <== bits.out[i];
    m.p[0] <== p[0];
    m.p[1] <== p[1];
    out[0] <== m.out[0];
    out[1] <== m.out[1];
}

// c[m] = plain[m] + Poseidon(k, m), k = Poseidon(shared.x, shared.y)
template Encrypt(n) {
    signal input shared[2];
    signal input plain[n];
    signal output c[n];
    component kh = Poseidon(2);
    kh.inputs[0] <== shared[0];
    kh.inputs[1] <== shared[1];
    component pad[n];
    for (var m = 0; m < n; m++) {
        pad[m] = Poseidon(2);
        pad[m].inputs[0] <== kh.out;
        pad[m].inputs[1] <== m;
        c[m] <== plain[m] + pad[m].out;
    }
}

template JoinSplit(depth) {
    // ---- private ----
    signal input ask;
    signal input inV[2];
    signal input inToken[2];
    signal input inR[2];
    signal input inIndex[2];
    signal input inSiblings[2][depth];
    signal input enabled1;
    signal input dummy;
    signal input outPk[2][2];
    signal input outV[2];
    signal input outR[2];
    signal input esk[2];

    // ---- public inputs ----
    signal input root;
    signal input vPub;
    signal input tokenPub;
    signal input to;
    signal input sender;
    signal input A[2];

    // ---- outputs (public) ----
    signal output nf[2];
    signal output cm[2];
    signal output epk[2][2];
    signal output cr[2][2];
    signal output ca[2][3];
    signal output senderPk[2];

    // 1. keys. ask < L (the subgroup order): the nullifier key is Poseidon(ask), so ask + k·L
    // would be a second nullifier for the same note and key
    component askBits = Num2Bits_strict();
    askBits.in <== ask;
    component askLt = CompConstant(2736030358979909402780800718157159386076813972158567259200215660948447373040);
    for (var i = 0; i < 254; i++) askLt.in[i] <== askBits.out[i];
    askLt.out === 0;
    component pk = BabyPbk();
    pk.in <== ask;
    senderPk[0] <== pk.Ax;
    senderPk[1] <== pk.Ay;
    component nkh = Poseidon(2);
    nkh.inputs[0] <== ask;
    nkh.inputs[1] <== 0;
    signal nk <== nkh.out;

    enabled1 * (1 - enabled1) === 0;
    signal enabled[2];
    enabled[0] <== 1;
    enabled[1] <== enabled1;
    signal token <== inToken[0];
    enabled[1] * (inToken[1] - token) === 0;
    // the two inputs are different leaves
    component sameLeaf = IsEqual();
    sameLeaf.in[0] <== inIndex[0];
    sameLeaf.in[1] <== inIndex[1];
    enabled[1] * sameLeaf.out === 0;

    // 2. inputs
    component inCm[2];
    component inBits[2];
    component inRoot[2];
    component inNf[2];
    component inRange[2];
    for (var i = 0; i < 2; i++) {
        inCm[i] = NoteCommitment();
        inCm[i].pk[0] <== pk.Ax;
        inCm[i].pk[1] <== pk.Ay;
        inCm[i].v <== inV[i];
        inCm[i].token <== inToken[i];
        inCm[i].r <== inR[i];

        inBits[i] = Num2Bits(depth);
        inBits[i].in <== inIndex[i];

        inRoot[i] = MerkleRoot(depth);
        inRoot[i].leaf <== inCm[i].cm;
        for (var l = 0; l < depth; l++) {
            inRoot[i].siblings[l] <== inSiblings[i][l];
            inRoot[i].bits[l] <== inBits[i].out[l];
        }
        enabled[i] * (inRoot[i].root - root) === 0;
        (1 - enabled[i]) * inV[i] === 0;

        inNf[i] = Poseidon(2);
        inNf[i].inputs[0] <== nk;
        inNf[i].inputs[1] <== inIndex[i];

        inRange[i] = Num2Bits(64);
        inRange[i].in <== inV[i];
    }
    nf[0] <== inNf[0].out;
    // a disabled second input still emits a nullifier, from a reserved domain above any leaf index
    component dummyBits = Num2Bits(40);
    dummyBits.in <== dummy;
    component dummyNf = Poseidon(2);
    dummyNf.inputs[0] <== nk;
    dummyNf.inputs[1] <== 1099511627776 + dummy;
    signal nfReal1 <== enabled[1] * inNf[1].out;
    signal nfDummy1 <== (1 - enabled[1]) * dummyNf.out;
    nf[1] <== nfReal1 + nfDummy1;

    // 3. balance
    component outRange[2];
    for (var j = 0; j < 2; j++) {
        outRange[j] = Num2Bits(64);
        outRange[j].in <== outV[j];
    }
    component pubRange = Num2Bits(64);
    pubRange.in <== vPub;
    inV[0] + inV[1] === outV[0] + outV[1] + vPub;
    vPub * (tokenPub - token) === 0;
    // `to` and `sender` are only bound: the proof is for one signer and one destination
    signal toBound <== to * to;
    signal senderBound <== sender * sender;

    // 4. outputs: commitment and the two encryptions
    component outCheck[2];
    component outCm[2];
    component ep[2];
    component sr[2];
    component sa[2];
    component er[2];
    component ea[2];
    component xbits[2];
    component dbl[2][3];
    component x8zero[2];
    component y8one[2];
    component eskZero[2];
    component eskBits[2];
    component eskLt[2];
    signal packed[2];
    signal packedA[2];
    for (var j = 0; j < 2; j++) {
        outCheck[j] = BabyCheck();
        outCheck[j].x <== outPk[j][0];
        outCheck[j].y <== outPk[j][1];
        // in the prime-order subgroup: 8·outPk is not the identity (cofactor 8)
        for (var k = 0; k < 3; k++) {
            dbl[j][k] = BabyDbl();
            dbl[j][k].x <== k == 0 ? outPk[j][0] : dbl[j][k - 1].xout;
            dbl[j][k].y <== k == 0 ? outPk[j][1] : dbl[j][k - 1].yout;
        }
        x8zero[j] = IsZero();
        x8zero[j].in <== dbl[j][2].xout;
        y8one[j] = IsEqual();
        y8one[j].in[0] <== dbl[j][2].yout;
        y8one[j].in[1] <== 1;
        x8zero[j].out * y8one[j].out === 0;
        // a zero ephemeral scalar would publish the plaintext; so would a multiple of the subgroup
        // order (the ephemeral key would be the identity), hence esk < L like ask
        eskZero[j] = IsZero();
        eskZero[j].in <== esk[j];
        eskZero[j].out === 0;
        eskBits[j] = Num2Bits_strict();
        eskBits[j].in <== esk[j];
        eskLt[j] = CompConstant(2736030358979909402780800718157159386076813972158567259200215660948447373040);
        for (var b = 0; b < 254; b++) eskLt[j].in[b] <== eskBits[j].out[b];
        eskLt[j].out === 0;

        outCm[j] = NoteCommitment();
        outCm[j].pk[0] <== outPk[j][0];
        outCm[j].pk[1] <== outPk[j][1];
        outCm[j].v <== outV[j];
        outCm[j].token <== token;
        outCm[j].r <== outR[j];
        cm[j] <== outCm[j].cm;

        ep[j] = BabyPbk();
        ep[j].in <== esk[j];
        epk[j][0] <== ep[j].Ax;
        epk[j][1] <== ep[j].Ay;

        sr[j] = MulPoint();
        sr[j].e <== esk[j];
        sr[j].p[0] <== outPk[j][0];
        sr[j].p[1] <== outPk[j][1];
        packed[j] <== outV[j] + token * 18446744073709551616;
        er[j] = Encrypt(2);
        er[j].shared[0] <== sr[j].out[0];
        er[j].shared[1] <== sr[j].out[1];
        er[j].plain[0] <== packed[j];
        er[j].plain[1] <== outR[j];
        for (var m = 0; m < 2; m++) cr[j][m] <== er[j].c[m];

        sa[j] = MulPoint();
        sa[j].e <== esk[j];
        sa[j].p[0] <== A[0];
        sa[j].p[1] <== A[1];
        // the receiver key travels as (y, parity of x): parity bit at 2^72 of the packed word
        xbits[j] = Num2Bits_strict();
        xbits[j].in <== outPk[j][0];
        packedA[j] <== packed[j] + xbits[j].out[0] * 4722366482869645213696;
        ea[j] = Encrypt(3);
        ea[j].shared[0] <== sa[j].out[0];
        ea[j].shared[1] <== sa[j].out[1];
        ea[j].plain[0] <== outPk[j][1];
        ea[j].plain[1] <== packedA[j];
        ea[j].plain[2] <== outR[j];
        for (var m = 0; m < 3; m++) ca[j][m] <== ea[j].c[m];
    }
}

component main {public [root, vPub, tokenPub, to, sender, A]} = JoinSplit(20);
