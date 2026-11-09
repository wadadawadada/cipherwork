import { generateKeyPairSync } from 'node:crypto';
import { KeyPair } from 'near-api-js';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
console.log(`VERIFIER_SEED_HEX=${seed}\nVERIFIER_PUBLIC_KEY_HEX=${pub}\n# NEAR account key (for relayer/owner/buyer):\n${KeyPair.fromRandom('ed25519').toString()}`);
