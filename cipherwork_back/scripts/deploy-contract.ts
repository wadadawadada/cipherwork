import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { accountFor, provider, txHashOf, explorerTx } from '../src/near.js';
import 'dotenv/config';

const ownerKey = process.env.CONTRACT_OWNER_PRIVATE_KEY!;
const acc = accountFor(config.ESCROW_CONTRACT_ID, ownerKey);
const wasm = readFileSync('contracts/build/order_escrow.wasm');
console.log(`Deploying ${wasm.length} bytes to ${config.ESCROW_CONTRACT_ID} (testnet)…`);
const dep = await acc.deployContract(wasm);
console.log('deploy tx:', explorerTx(txHashOf(dep)));

let initialized = true;
try { await provider.callFunction({ contractId: config.ESCROW_CONTRACT_ID, method: 'get_config', args: {} }); } catch { initialized = false; }
if (!initialized) {
  const res = await acc.callFunctionRaw({
    contractId: config.ESCROW_CONTRACT_ID, methodName: 'new',
    args: {
      owner: config.ESCROW_CONTRACT_ID, treasury: config.TREASURY_ACCOUNT_ID,
      verifier_public_key_hex: config.VERIFIER_PUBLIC_KEY_HEX, verifier_key_id: config.VERIFIER_KEY_ID,
      fee_bps: config.FEE_BPS, timelock_ms: 60_000,
    },
    gas: 100_000_000_000_000n,
  });
  console.log('init tx:', explorerTx(txHashOf(res)));
} else console.log('already initialized');
console.log(JSON.stringify(await provider.callFunction({ contractId: config.ESCROW_CONTRACT_ID, method: 'get_config', args: {} }), null, 2));
