// Builds the escrow wasm. On Windows with a broken MSVC CRT, set LIB to a working toolchain first (see docs/integrations.md).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
const env = { ...process.env, RUSTFLAGS: '-C target-cpu=mvp' };
const r = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: 'contracts/order-escrow', stdio: 'inherit', env, shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
mkdirSync('contracts/build', { recursive: true });
copyFileSync('contracts/order-escrow/target/wasm32-unknown-unknown/release/cipherwork_order_escrow.wasm', 'contracts/build/order_escrow.wasm');
console.log('wrote contracts/build/order_escrow.wasm');
