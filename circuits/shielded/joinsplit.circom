pragma circom 2.1.0;

// Shielded join-split (docs/06-shielded-design.md §2.3): two input notes, two output notes.
//
// Note: (pk, v, token, rho, r); cm = Poseidon(pk.x, pk.y, v, token, rho, r).
// Keys: pk = ask·B8 (circomlib Base8), nk = Poseidon(ask, 0), nf = Poseidon(nk, leafIndex).
// Encryption to a point P with ephemeral esk: k = Poseidon((esk·P).x, (esk·P).y),
// c[m] = plain[m] + Poseidon(k, m).
//
// Revision 2 (docs/06 §8): the sender's wallet signs the action, so the sender's key is a
// public output the contract checks against the sender's registration, and the sender's
// account name is bound. Value and token pack into one word (v + token·2^64); the auditor
// ciphertext no longer carries the sender key (the action names the sender).
//
// Public signals, in snarkjs order (outputs first, then public inputs):
//   nf[2] cm[2] epk[2][2] cr[2][3] ca[2][5] senderPk[2]     (outputs, 26)
//   root vPub tokenPub to sender A[2]                       (public inputs, 7)
//
// Input 0 is always a real note. Input 1 may be disabled (enabled1 = 0): then it carries no
// value, is not checked against the tree, and its nullifier is 0 (the contract skips zeros).

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/bitify.circom";

template NoteCommitment() {
    signal input pk[2];
    signal input v;
    signal input token;
    signal input rho;
    signal input r;
    signal output cm;
    component h = Poseidon(6);
    h.inputs[0] <== pk[0];
    h.inputs[1] <== pk[1];
    h.inputs[2] <== v;
    h.inputs[3] <== token;
    h.inputs[4] <== rho;
    h.inputs[5] <== r;
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
    signal input inRho[2];
    signal input inR[2];
    signal input inIndex[2];
    signal input inSiblings[2][depth];
    signal input enabled1;
    signal input outPk[2][2];
    signal input outV[2];
    signal input outRho[2];
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
    signal output cr[2][3];
    signal output ca[2][5];
    signal output senderPk[2];

    // 1. keys
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
        inCm[i].rho <== inRho[i];
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
        nf[i] <== enabled[i] * inNf[i].out;

        inRange[i] = Num2Bits(64);
        inRange[i].in <== inV[i];
    }

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
    signal packed[2];
    for (var j = 0; j < 2; j++) {
        outCheck[j] = BabyCheck();
        outCheck[j].x <== outPk[j][0];
        outCheck[j].y <== outPk[j][1];

        outCm[j] = NoteCommitment();
        outCm[j].pk[0] <== outPk[j][0];
        outCm[j].pk[1] <== outPk[j][1];
        outCm[j].v <== outV[j];
        outCm[j].token <== token;
        outCm[j].rho <== outRho[j];
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
        er[j] = Encrypt(3);
        er[j].shared[0] <== sr[j].out[0];
        er[j].shared[1] <== sr[j].out[1];
        er[j].plain[0] <== packed[j];
        er[j].plain[1] <== outRho[j];
        er[j].plain[2] <== outR[j];
        for (var m = 0; m < 3; m++) cr[j][m] <== er[j].c[m];

        sa[j] = MulPoint();
        sa[j].e <== esk[j];
        sa[j].p[0] <== A[0];
        sa[j].p[1] <== A[1];
        ea[j] = Encrypt(5);
        ea[j].shared[0] <== sa[j].out[0];
        ea[j].shared[1] <== sa[j].out[1];
        ea[j].plain[0] <== outPk[j][0];
        ea[j].plain[1] <== outPk[j][1];
        ea[j].plain[2] <== packed[j];
        ea[j].plain[3] <== outRho[j];
        ea[j].plain[4] <== outR[j];
        for (var m = 0; m < 5; m++) ca[j][m] <== ea[j].c[m];
    }
}

component main {public [root, vPub, tokenPub, to, sender, A]} = JoinSplit(20);
