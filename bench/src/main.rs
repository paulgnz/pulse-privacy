//! Phase-0 verifier micro-benchmarks for the confidential-transfer track.
//!
//! Everything here is the *verifier* side (what a PulseVM validator pays per transaction),
//! plus the few wallet-side numbers the design depends on. Run with:
//!
//!     cargo run --release            # markdown table on stdout
//!     cargo run --release -- --iters 500
//!
//! Sections:
//!   A. bn254 primitives that map 1:1 onto Leap's `alt_bn128_add/mul/pair` intrinsics
//!   B. Groth16 verify on bn254 as a function of public-input count (circuit size is irrelevant
//!      to verify cost — only the number of public inputs and the one 4-pair pairing check)
//!   C. Baby Jubjub (ed-on-bn254) point ops — what the *contract* does in WASM to add
//!      ciphertexts homomorphically, and what the wallet does to decrypt (BSGS on a 32-bit chunk)
//!   D. Bulletproofs (ristretto255) range-proof verify — the no-trusted-setup fallback

use std::collections::HashMap;
use std::hint::black_box;
use std::time::{Duration, Instant};

use ark_bn254::{Bn254, Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{pairing::Pairing, CurveGroup, PrimeGroup};
use ark_ff::{BigInteger, PrimeField, UniformRand, Zero};
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, ProvingKey};
use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::fp::FpVar};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::CanonicalSerialize;
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};

use ark_ed_on_bn254::{EdwardsAffine as JubAffine, EdwardsProjective as JubProjective, Fr as JubFr};

use bulletproofs::{BulletproofGens, PedersenGens, RangeProof};
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use merlin::Transcript;

// ------------------------------------------------------------------------------------------
// timing harness
// ------------------------------------------------------------------------------------------

struct Stats {
    name: String,
    min: Duration,
    median: Duration,
    p90: Duration,
    note: String,
}

fn bench<F: FnMut()>(name: &str, iters: usize, note: &str, mut f: F) -> Stats {
    for _ in 0..3 {
        f();
    }
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        f();
        samples.push(t.elapsed());
    }
    samples.sort();
    Stats {
        name: name.to_string(),
        min: samples[0],
        median: samples[samples.len() / 2],
        p90: samples[(samples.len() * 9) / 10],
        note: note.to_string(),
    }
}

fn fmt_us(d: Duration) -> String {
    let us = d.as_secs_f64() * 1e6;
    if us < 10.0 {
        format!("{:.2} µs", us)
    } else if us < 1000.0 {
        format!("{:.1} µs", us)
    } else {
        format!("{:.3} ms", us / 1000.0)
    }
}

fn print_table(title: &str, rows: &[Stats]) {
    println!("\n### {title}\n");
    println!("| operation | min | median | p90 | note |");
    println!("|---|---:|---:|---:|---|");
    for r in rows {
        println!(
            "| {} | {} | {} | {} | {} |",
            r.name,
            fmt_us(r.min),
            fmt_us(r.median),
            fmt_us(r.p90),
            r.note
        );
    }
}

// ------------------------------------------------------------------------------------------
// A. bn254 primitives (alt_bn128_add / alt_bn128_mul / alt_bn128_pair)
// ------------------------------------------------------------------------------------------

fn bench_bn254_primitives(iters: usize, rng: &mut StdRng) -> Vec<Stats> {
    let mut out = Vec::new();

    let p1 = G1Projective::rand(rng).into_affine();
    let p2 = G1Projective::rand(rng).into_affine();
    let q = G2Projective::rand(rng).into_affine();
    let s = Fr::rand(rng);

    out.push(bench("bn254 G1 add (affine in/out)", iters, "= alt_bn128_add", || {
        let _ = black_box((black_box(p1) + black_box(p2)).into_affine());
    }));
    out.push(bench("bn254 G1 scalar mul (affine in/out)", iters, "= alt_bn128_mul", || {
        let _ = black_box((black_box(p1) * black_box(s)).into_affine());
    }));
    out.push(bench("bn254 G2 scalar mul", iters, "not an intrinsic; VK prep only", || {
        let _ = black_box((black_box(q) * black_box(s)).into_affine());
    }));

    for k in [1usize, 2, 4] {
        let g1s: Vec<G1Affine> = (0..k).map(|_| G1Projective::rand(rng).into_affine()).collect();
        let g2s: Vec<G2Affine> = (0..k).map(|_| G2Projective::rand(rng).into_affine()).collect();
        out.push(bench(
            &format!("bn254 pairing check, {k} pair(s)"),
            iters,
            if k == 4 { "= alt_bn128_pair as used by Groth16 verify" } else { "= alt_bn128_pair" },
            || {
                let _ = black_box(Bn254::multi_pairing(black_box(&g1s), black_box(&g2s)));
            },
        ));
    }
    out
}

// ------------------------------------------------------------------------------------------
// B. Groth16 verify vs public-input count
// ------------------------------------------------------------------------------------------

/// Shape-only stand-in for the transfer circuit. Verify cost does not depend on the constraint
/// count, only on `n_pub`, so the circuit is deliberately tiny: prove knowledge of square roots
/// of each public input, plus a chain of `n_pad` dummy multiplications.
#[derive(Clone)]
struct ShapeCircuit {
    pub_inputs: Vec<Fr>,
    roots: Vec<Fr>,
    n_pad: usize,
}

impl ConstraintSynthesizer<Fr> for ShapeCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        for (x, w) in self.pub_inputs.iter().zip(self.roots.iter()) {
            let x_var = FpVar::new_input(cs.clone(), || Ok(*x))?;
            let w_var = FpVar::new_witness(cs.clone(), || Ok(*w))?;
            let sq = &w_var * &w_var;
            sq.enforce_equal(&x_var)?;
        }
        let mut acc = FpVar::new_witness(cs.clone(), || Ok(Fr::from(3u64)))?;
        for _ in 0..self.n_pad {
            acc = &acc * &acc;
        }
        let _ = acc;
        Ok(())
    }
}

struct Groth16Fixture {
    pvk: PreparedVerifyingKey<Bn254>,
    proof: Proof<Bn254>,
    inputs: Vec<Fr>,
    proof_bytes: usize,
    vk_bytes: usize,
    prove_time: Duration,
    setup_time: Duration,
}

fn groth16_fixture(n_pub: usize, n_pad: usize, rng: &mut StdRng) -> Groth16Fixture {
    let roots: Vec<Fr> = (0..n_pub).map(|_| Fr::rand(rng)).collect();
    let pub_inputs: Vec<Fr> = roots.iter().map(|r| *r * *r).collect();
    let circuit = ShapeCircuit { pub_inputs: pub_inputs.clone(), roots, n_pad };

    let t = Instant::now();
    let (pk, vk): (ProvingKey<Bn254>, _) =
        Groth16::<Bn254>::circuit_specific_setup(circuit.clone(), rng).expect("setup");
    let setup_time = t.elapsed();

    let t = Instant::now();
    let proof = Groth16::<Bn254>::prove(&pk, circuit, rng).expect("prove");
    let prove_time = t.elapsed();

    let pvk = Groth16::<Bn254>::process_vk(&vk).expect("process vk");
    let ok = Groth16::<Bn254>::verify_with_processed_vk(&pvk, &pub_inputs, &proof).expect("verify");
    assert!(ok, "fixture proof must verify");

    Groth16Fixture {
        pvk,
        proof_bytes: proof.compressed_size(),
        vk_bytes: vk.compressed_size(),
        proof,
        inputs: pub_inputs,
        prove_time,
        setup_time,
    }
}

fn bench_groth16(iters: usize, rng: &mut StdRng) -> (Vec<Stats>, Vec<String>) {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    // n_pub: 8 ≈ minimal; 24 ≈ our transfer circuit (sender/receiver/auditor pubkeys,
    // old+new balance ciphertexts, transfer ciphertext chunks, nonce); 64 = headroom.
    for (n_pub, n_pad) in [(8usize, 1_000usize), (24, 20_000), (64, 20_000)] {
        let fx = groth16_fixture(n_pub, n_pad, rng);
        notes.push(format!(
            "n_pub={n_pub}, ~{n_pad} pad constraints: proof {} B (compressed), vk {} B, setup {}, prove {}",
            fx.proof_bytes,
            fx.vk_bytes,
            fmt_us(fx.setup_time),
            fmt_us(fx.prove_time)
        ));
        let (pvk, proof, inputs) = (fx.pvk, fx.proof, fx.inputs);
        out.push(bench(
            &format!("Groth16 verify, {n_pub} public inputs"),
            iters,
            "MSM(n_pub) + 4-pair pairing; prepared VK",
            || {
                let ok = Groth16::<Bn254>::verify_with_processed_vk(
                    black_box(&pvk),
                    black_box(&inputs),
                    black_box(&proof),
                )
                .unwrap();
                assert!(ok);
            },
        ));
    }
    (out, notes)
}

// ------------------------------------------------------------------------------------------
// C. Baby Jubjub: contract-side homomorphic adds, wallet-side decrypt
// ------------------------------------------------------------------------------------------

fn jub_key(p: &JubAffine) -> [u8; 64] {
    let mut k = [0u8; 64];
    let x = p.x.into_bigint().to_bytes_le();
    let y = p.y.into_bigint().to_bytes_le();
    k[..32].copy_from_slice(&x);
    k[32..].copy_from_slice(&y);
    k
}

/// Baby-step giant-step discrete log for v in [0, 2^32) given v·G. Baby table 2^16 entries.
/// Returns (v, giant steps taken). Worst case = 2^16 giant steps, done as one batch of
/// projective adds followed by a single batch normalisation (one field inversion total).
fn bsgs32(target: JubAffine, g: JubAffine, table: &HashMap<[u8; 64], u32>) -> Option<u64> {
    const BABY: u64 = 1 << 16;
    let giant = (g * JubFr::from(BABY)).into_affine();
    let neg_giant = -giant;
    let mut cands: Vec<JubProjective> = Vec::with_capacity(BABY as usize);
    let mut cur: JubProjective = target.into();
    for _ in 0..BABY {
        cands.push(cur);
        cur += neg_giant;
    }
    let affs = JubProjective::normalize_batch(&cands);
    for (j, a) in affs.iter().enumerate() {
        if let Some(i) = table.get(&jub_key(a)) {
            return Some(*i as u64 + (j as u64) * BABY);
        }
    }
    None
}

fn bench_babyjubjub(iters: usize, rng: &mut StdRng) -> Vec<Stats> {
    let mut out = Vec::new();
    let g = JubProjective::generator().into_affine();
    let a = JubProjective::rand(rng);
    let b = JubProjective::rand(rng).into_affine();
    let s = JubFr::rand(rng);

    out.push(bench("BabyJubjub point add (proj += affine)", iters, "contract: 2 per ciphertext chunk added", || {
        let _ = black_box(black_box(a) + black_box(b));
    }));
    out.push(bench("BabyJubjub point add + normalise to affine", iters, "if the table stores affine points", || {
        let _ = black_box((black_box(a) + black_box(b)).into_affine());
    }));
    out.push(bench("BabyJubjub scalar mul", iters, "wallet: encrypt = 2–3 of these per chunk", || {
        let _ = black_box(black_box(a) * black_box(s));
    }));

    // Baby-step table 2^16 (built once per wallet, cacheable).
    let t = Instant::now();
    let mut table: HashMap<[u8; 64], u32> = HashMap::with_capacity(1 << 16);
    let mut cur = JubProjective::zero();
    let mut pts = Vec::with_capacity(1 << 16);
    for _ in 0..(1u32 << 16) {
        pts.push(cur);
        cur += g;
    }
    for (i, p) in JubProjective::normalize_batch(&pts).iter().enumerate() {
        table.insert(jub_key(p), i as u32);
    }
    let table_time = t.elapsed();
    out.push(Stats {
        name: "BabyJubjub BSGS table build (2^16 entries)".into(),
        min: table_time,
        median: table_time,
        p90: table_time,
        note: "once per wallet, cacheable".into(),
    });

    // Worst case: v near 2^32 - 1 -> all 2^16 giant steps.
    let v_worst: u64 = (1u64 << 32) - 7;
    let target_worst = (g * JubFr::from(v_worst)).into_affine();
    assert_eq!(bsgs32(target_worst, g, &table), Some(v_worst));
    out.push(bench("BabyJubjub decrypt 32-bit chunk, worst case (BSGS)", (iters / 20).max(3), "wallet-side, per balance chunk", || {
        black_box(bsgs32(black_box(target_worst), g, &table));
    }));
    out
}

// ------------------------------------------------------------------------------------------
// D. Bulletproofs (ristretto255)
// ------------------------------------------------------------------------------------------

fn bench_bulletproofs(iters: usize) -> (Vec<Stats>, Vec<String>) {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    let pc = PedersenGens::default();
    let bp = BulletproofGens::new(64, 4);
    let mut rng = rand::thread_rng();

    // Ristretto primitives for reference (what a ristretto MSM intrinsic would be built from).
    let p = RistrettoPoint::random(&mut rng);
    let q = RistrettoPoint::random(&mut rng);
    let s = Scalar::random(&mut rng);
    out.push(bench("ristretto255 point add", iters, "", || {
        black_box(black_box(p) + black_box(q));
    }));
    out.push(bench("ristretto255 scalar mul", iters, "", || {
        black_box(black_box(p) * black_box(s));
    }));

    for (bits, m) in [(32usize, 1usize), (64, 1), (64, 2), (64, 4)] {
        let values: Vec<u64> = (0..m).map(|i| 1234_u64 + i as u64).collect();
        let blindings: Vec<Scalar> = (0..m).map(|_| Scalar::random(&mut rng)).collect();
        let t = Instant::now();
        let (proof, commits) = RangeProof::prove_multiple(
            &bp,
            &pc,
            &mut Transcript::new(b"pulse-privacy-bench"),
            &values,
            &blindings,
            bits,
        )
        .expect("bp prove");
        let prove_time = t.elapsed();
        let size = proof.to_bytes().len();
        notes.push(format!("{bits}-bit × {m}: proof {size} B, prove {}", fmt_us(prove_time)));
        out.push(bench(
            &format!("Bulletproofs range verify {bits}-bit × {m}"),
            iters,
            "would need a bespoke intrinsic (no pairing)",
            || {
                proof
                    .verify_multiple(
                        black_box(&bp),
                        black_box(&pc),
                        &mut Transcript::new(b"pulse-privacy-bench"),
                        black_box(&commits),
                        bits,
                    )
                    .expect("bp verify");
            },
        ));
    }
    (out, notes)
}

// ------------------------------------------------------------------------------------------
// Fixture emission for the WASM guest (bench/wasm-guest): serialised vk/proof/inputs so the
// guest measures exactly the same verification the native rows measure.
// ------------------------------------------------------------------------------------------

fn emit_fixtures(dir: &str, rng: &mut StdRng) {
    use ark_groth16::VerifyingKey;
    std::fs::create_dir_all(dir).expect("mkdir fixtures");
    for (n_pub, n_pad) in [(8usize, 1_000usize), (24, 20_000)] {
        let roots: Vec<Fr> = (0..n_pub).map(|_| Fr::rand(rng)).collect();
        let pub_inputs: Vec<Fr> = roots.iter().map(|r| *r * *r).collect();
        let circuit = ShapeCircuit { pub_inputs: pub_inputs.clone(), roots, n_pad };
        let (pk, vk): (ProvingKey<Bn254>, VerifyingKey<Bn254>) =
            Groth16::<Bn254>::circuit_specific_setup(circuit.clone(), rng).expect("setup");
        let proof = Groth16::<Bn254>::prove(&pk, circuit, rng).expect("prove");
        assert!(Groth16::<Bn254>::verify(&vk, &pub_inputs, &proof).unwrap());
        let mut buf = Vec::new();
        vk.serialize_compressed(&mut buf).unwrap();
        std::fs::write(format!("{dir}/groth16_{n_pub}_vk.bin"), &buf).unwrap();
        buf.clear();
        proof.serialize_compressed(&mut buf).unwrap();
        std::fs::write(format!("{dir}/groth16_{n_pub}_proof.bin"), &buf).unwrap();
        buf.clear();
        pub_inputs.serialize_compressed(&mut buf).unwrap();
        std::fs::write(format!("{dir}/groth16_{n_pub}_inputs.bin"), &buf).unwrap();
    }
    let pc = PedersenGens::default();
    let bp = BulletproofGens::new(64, 1);
    let mut trng = rand::thread_rng();
    let (proof, commit) = RangeProof::prove_single(
        &bp, &pc, &mut Transcript::new(b"pulse-privacy-bench"), 1234, &Scalar::random(&mut trng), 64,
    ).expect("bp prove");
    std::fs::write(format!("{dir}/bp64_proof.bin"), proof.to_bytes()).unwrap();
    std::fs::write(format!("{dir}/bp64_commit.bin"), commit.as_bytes()).unwrap();
    println!("fixtures written to {dir}");
}

fn machine_info() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    let cpu = std::process::Command::new("sh")
        .arg("-c")
        .arg("sysctl -n machdep.cpu.brand_string 2>/dev/null || grep -m1 'model name' /proc/cpuinfo | cut -d: -f2")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    format!("{host} · {cpu} · {arch}-{os}")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut iters = 200usize;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--iters" {
            iters = args[i + 1].parse().expect("--iters N");
            i += 1;
        } else if args[i] == "--emit-fixtures" {
            let mut rng = StdRng::seed_from_u64(0x5051_2026);
            emit_fixtures(&args[i + 1], &mut rng);
            return;
        }
        i += 1;
    }

    let mut rng = StdRng::seed_from_u64(0x5051_2026);

    println!("# pulse-privacy verifier benchmarks");
    println!();
    println!("Machine: {}", machine_info());
    println!("Iterations per row: {iters} (median reported; warm-up excluded). Single thread.");

    let a = bench_bn254_primitives(iters, &mut rng);
    print_table("A. bn254 primitives (Leap `alt_bn128_*` equivalents), native Rust (arkworks)", &a);

    let (b, notes) = bench_groth16(iters, &mut rng);
    print_table("B. Groth16 verify on bn254 (arkworks), by public-input count", &b);
    for n in notes {
        println!("- {n}");
    }

    let c = bench_babyjubjub(iters, &mut rng);
    print_table("C. Baby Jubjub (ed-on-bn254) — contract-side ciphertext adds, wallet-side decrypt", &c);

    let (d, notes) = bench_bulletproofs(iters);
    print_table("D. Bulletproofs on ristretto255 (dalek) — no-setup fallback", &d);
    for n in notes {
        println!("- {n}");
    }
}
