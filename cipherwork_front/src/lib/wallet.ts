import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, keyToImplicitAddress } from 'near-api-js';

export const RPC_URL = 'https://test.rpc.fastnear.com';
export const EXPLORER = 'https://testnet.nearblocks.io';
const KEY = 'cipherwork.testnet-burner.v1';
const provider = new JsonRpcProvider({ url: RPC_URL });

/**
 * TESTNET-ONLY burner wallet generated in this browser. It only ever holds worthless testnet NEAR.
 * It is stored in localStorage purely as a convenience; it never touches the backend and never holds private job data.
 */
export function loadBurner(): { accountId: string; secret: string } {
  let secret: string | null = null;
  try { secret = localStorage.getItem(KEY); } catch { /* storage may be unavailable */ }
  if (!secret) {
    secret = KeyPair.fromRandom('ed25519').toString();
    try { localStorage.setItem(KEY, secret); } catch { /* ignore */ }
  }
  const kp = KeyPair.fromString(secret as `ed25519:${string}`);
  return { accountId: keyToImplicitAddress(kp.getPublicKey().toString()), secret };
}

export function resetBurner() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export const account = (b: { accountId: string; secret: string }) =>
  new Account(b.accountId, provider, KeyPairSigner.fromSecretKey(b.secret as `ed25519:${string}`));

export async function balanceYocto(accountId: string): Promise<bigint> {
  try { const a: any = await provider.viewAccount({ accountId }); return BigInt(a.amount); } catch { return 0n; }
}

export async function contractView<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export const fmtNear = (y: bigint | string, digits = 4) => {
  const v = BigInt(y); const whole = v / 10n ** 24n; const frac = (v % 10n ** 24n).toString().padStart(24, '0').slice(0, digits);
  return `${whole}.${frac}`;
};
