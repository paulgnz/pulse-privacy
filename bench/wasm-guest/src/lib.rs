//! WASM guest: the same verifiers as `bench/src/main.rs`, compiled to wasm32-unknown-unknown.
//! The host (`bench/wasm-host`) runs each export under wasmer with pulsevm's metering
//! middleware and reports wall-clock and instruction-points per iteration.
//!
//! Fixtures are produced by `cargo run --release -- --emit-fixtures ../fixtures` in `bench/`.

use ark_bn254::{Bn254, Fr};
use ark_ec::CurveGroup;
use ark_groth16::{Groth16, Proof, VerifyingKey};
use ark_serialize::CanonicalDeserialize;
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};
use ark_std::UniformRand;

use ark_ed_on_bn254::{EdwardsAffine as JubAffine, EdwardsProjective as JubProjective};

use bulletproofs::{BulletproofGens, PedersenGens, RangeProof};
use curve25519_dalek::ristretto::CompressedRistretto;
use merlin::Transcript;

// No OS entropy in wasm32-unknown-unknown; nothing on the verify path needs randomness
// (Bulletproofs verify takes an explicit rng below). Keep the linker happy.
fn no_entropy(_buf: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(no_entropy);

static G16_8_VK: &[u8] = include_bytes!("../../fixtures/groth16_8_vk.bin");
static G16_8_PROOF: &[u8] = include_bytes!("../../fixtures/groth16_8_proof.bin");
static G16_8_INPUTS: &[u8] = include_bytes!("../../fixtures/groth16_8_inputs.bin");
static G16_24_VK: &[u8] = include_bytes!("../../fixtures/groth16_24_vk.bin");
static G16_24_PROOF: &[u8] = include_bytes!("../../fixtures/groth16_24_proof.bin");
static G16_24_INPUTS: &[u8] = include_bytes!("../../fixtures/groth16_24_inputs.bin");
static BP64_PROOF: &[u8] = include_bytes!("../../fixtures/bp64_proof.bin");
static BP64_COMMIT: &[u8] = include_bytes!("../../fixtures/bp64_commit.bin");

fn groth16_run(vk_b: &[u8], proof_b: &[u8], inputs_b: &[u8], iters: u32, prepared: bool) -> u32 {
    let vk = VerifyingKey::<Bn254>::deserialize_compressed(vk_b).unwrap();
    let proof = Proof::<Bn254>::deserialize_compressed(proof_b).unwrap();
    let inputs = Vec::<Fr>::deserialize_compressed(inputs_b).unwrap();
    let mut ok = 0u32;
    if prepared {
        let pvk = Groth16::<Bn254>::process_vk(&vk).unwrap();
        for _ in 0..iters {
            ok += Groth16::<Bn254>::verify_with_processed_vk(&pvk, &inputs, &proof).unwrap() as u32;
        }
    } else {
        for _ in 0..iters {
            // What a contract would do: verifying key straight from table storage, no G2 precomp.
            ok += Groth16::<Bn254>::verify(&vk, &inputs, &proof).unwrap() as u32;
        }
    }
    ok
}

#[no_mangle]
pub extern "C" fn groth16_verify_8(iters: u32) -> u32 {
    groth16_run(G16_8_VK, G16_8_PROOF, G16_8_INPUTS, iters, false)
}

#[no_mangle]
pub extern "C" fn groth16_verify_24(iters: u32) -> u32 {
    groth16_run(G16_24_VK, G16_24_PROOF, G16_24_INPUTS, iters, false)
}

#[no_mangle]
pub extern "C" fn groth16_verify_24_prepared(iters: u32) -> u32 {
    groth16_run(G16_24_VK, G16_24_PROOF, G16_24_INPUTS, iters, true)
}

/// Contract-side homomorphic update: `iters` Baby Jubjub point additions (projective += affine),
/// then one normalisation. A confidential transfer does ~8 of these (4 chunk ciphertexts × 2).
#[no_mangle]
pub extern "C" fn jub_add(iters: u32) -> u32 {
    let mut rng = StdRng::seed_from_u64(7);
    let mut acc = JubProjective::rand(&mut rng);
    let b: JubAffine = JubProjective::rand(&mut rng).into_affine();
    for _ in 0..iters {
        acc += b;
    }
    let a = acc.into_affine();
    (a.x.0 .0[0] & 0xff) as u32
}

/// Same, but normalising to affine after every add (as a naive contract storing affine points
/// would).
#[no_mangle]
pub extern "C" fn jub_add_affine(iters: u32) -> u32 {
    let mut rng = StdRng::seed_from_u64(7);
    let mut acc: JubAffine = JubProjective::rand(&mut rng).into_affine();
    let b: JubAffine = JubProjective::rand(&mut rng).into_affine();
    for _ in 0..iters {
        acc = (JubProjective::from(acc) + b).into_affine();
    }
    (acc.x.0 .0[0] & 0xff) as u32
}

#[no_mangle]
pub extern "C" fn bp_verify_64(iters: u32) -> u32 {
    let pc = PedersenGens::default();
    let bp = BulletproofGens::new(64, 1);
    let proof = RangeProof::from_bytes(BP64_PROOF).unwrap();
    let commit = CompressedRistretto::from_slice(BP64_COMMIT).unwrap();
    let mut rng = StdRng::seed_from_u64(11);
    let mut ok = 0u32;
    for _ in 0..iters {
        ok += proof
            .verify_single_with_rng(&bp, &pc, &mut Transcript::new(b"pulse-privacy-bench"), &commit, 64, &mut rng)
            .is_ok() as u32;
    }
    ok
}
