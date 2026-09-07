//! Runs the WASM guest under wasmer with the same metering middleware and cost function as
//! pulsevm (`crates/pulsevm_core/src/chain/wasm_runtime.rs`), so the "points" column is what
//! the contract would actually be billed (points / CPU_SCALE = billed µs).
//!
//!     cargo run --release -- ../wasm-guest/target/wasm32-unknown-unknown/release/pulse_privacy_wasm_guest.wasm
//!     LLVM_SYS_211_PREFIX=/opt/homebrew/opt/llvm@21 cargo run --release --features llvm -- <wasm>

use std::sync::Arc;
use std::time::Instant;

use wasmer::sys::{CompilerConfig, Cranelift};
use wasmer::wasmparser::Operator;
use wasmer::{imports, Engine, Instance, Module, Store, Value};
use wasmer_middlewares::metering::{get_remaining_points, set_remaining_points, MeteringPoints};
use wasmer_middlewares::Metering;

// --- verbatim from pulsevm wasm_runtime.rs (COST_FUNCTION, CPU_SCALE) -----------------------
const COST_FUNCTION: fn(&Operator) -> u64 = |operator: &Operator| -> u64 {
    match operator {
        Operator::Drop => 2,
        Operator::Select => 3,
        Operator::Br { .. }
        | Operator::BrTable { .. }
        | Operator::Call { .. }
        | Operator::CallIndirect { .. }
        | Operator::Return { .. } => 2,
        Operator::BrIf { .. } => 3,
        Operator::GlobalGet { .. }
        | Operator::GlobalSet { .. }
        | Operator::LocalGet { .. }
        | Operator::LocalSet { .. } => 3,
        Operator::I32Mul { .. }
        | Operator::I64Mul { .. }
        | Operator::F32Mul { .. }
        | Operator::F64Mul { .. } => 3,
        Operator::I32DivS { .. }
        | Operator::I32DivU { .. }
        | Operator::I32RemS { .. }
        | Operator::I32RemU { .. }
        | Operator::I64DivS { .. }
        | Operator::I64DivU { .. }
        | Operator::I64RemS { .. }
        | Operator::I64RemU { .. } => 80,
        Operator::I32Clz { .. } | Operator::I64Clz { .. } => 105,
        Operator::MemoryCopy { .. } | Operator::MemoryFill { .. } => 500,
        Operator::MemoryGrow { .. } => 1000,
        _ => 1,
    }
};
const CPU_SCALE: u64 = 143;
const MAX_TX_CPU_US: u64 = 150_000; // controller.rs default max_transaction_cpu_usage
// --------------------------------------------------------------------------------------------

struct Row {
    name: &'static str,
    iters: u32,
}

const ROWS: &[Row] = &[
    Row { name: "groth16_verify_8", iters: 20 },
    Row { name: "groth16_verify_24", iters: 20 },
    Row { name: "groth16_verify_24_prepared", iters: 20 },
    Row { name: "jub_add", iters: 100_000 },
    Row { name: "jub_add_affine", iters: 10_000 },
    Row { name: "bp_verify_64", iters: 20 },
];

fn run_backend(label: &str, engine: Engine, wasm: &[u8]) {
    let mut store = Store::new(engine);
    let t = Instant::now();
    let module = Module::new(&store, wasm).expect("compile");
    let compile = t.elapsed();
    let instance = Instance::new(&mut store, &module, &imports! {}).expect("instantiate");
    println!("\n### WASM under wasmer `{label}` + pulsevm metering (compile {:.2} s)\n", compile.as_secs_f64());
    println!("| export | iters | wall / iter | points / iter | billed µs / iter (points/{CPU_SCALE}) | % of {}-ms tx limit |", MAX_TX_CPU_US / 1000);
    println!("|---|---:|---:|---:|---:|---:|");
    for row in ROWS {
        let f = instance.exports.get_function(row.name).expect("export");
        let budget = u64::MAX / 4;
        // warm-up (with budget raised first: the initial 1_000-point limit would trap)
        set_remaining_points(&mut store, &instance, budget);
        f.call(&mut store, &[Value::I32(1)]).expect("call");
        set_remaining_points(&mut store, &instance, budget);
        let t = Instant::now();
        let r = f.call(&mut store, &[Value::I32(row.iters as i32)]).expect("call");
        let wall = t.elapsed();
        let used = match get_remaining_points(&mut store, &instance) {
            MeteringPoints::Remaining(p) => budget - p,
            MeteringPoints::Exhausted => panic!("exhausted"),
        };
        let ret = r[0].unwrap_i32();
        if row.name.starts_with("groth16") || row.name.starts_with("bp_") {
            assert_eq!(ret as u32, row.iters, "{}: verifier returned false", row.name);
        }
        let wall_us = wall.as_secs_f64() * 1e6 / row.iters as f64;
        let pts = used as f64 / row.iters as f64;
        let billed_us = pts / CPU_SCALE as f64;
        let pct = 100.0 * billed_us / MAX_TX_CPU_US as f64;
        println!(
            "| {} | {} | {} | {:.0} | {:.1} | {:.1}% |",
            row.name,
            row.iters,
            if wall_us >= 1000.0 { format!("{:.3} ms", wall_us / 1000.0) } else { format!("{:.2} µs", wall_us) },
            pts,
            billed_us,
            pct
        );
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: wasm-host <guest.wasm>");
    let wasm = std::fs::read(&path).expect("read wasm");
    println!("guest: {} ({} KiB)", path, wasm.len() / 1024);

    {
        let mut c = Cranelift::default();
        c.push_middleware(Arc::new(Metering::new(1_000, COST_FUNCTION)));
        run_backend("cranelift", Engine::from(c), &wasm);
    }
    #[cfg(feature = "llvm")]
    {
        use wasmer_compiler_llvm::{LLVMOptLevel, LLVM};
        let mut c = LLVM::default();
        c.push_middleware(Arc::new(Metering::new(1_000, COST_FUNCTION)));
        LLVM::canonicalize_nans(&mut c, true);
        LLVM::opt_level(&mut c, LLVMOptLevel::Aggressive);
        run_backend("llvm (pulsevm config)", Engine::from(c), &wasm);
    }
    #[cfg(not(feature = "llvm"))]
    println!("\n(llvm backend not built; rerun with --features llvm and LLVM_SYS_211_PREFIX set)");
}
