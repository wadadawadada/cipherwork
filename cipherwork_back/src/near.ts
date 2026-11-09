import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import { config } from './config.js';

export const provider = new JsonRpcProvider({ url: config.NEAR_RPC_URL });

export function accountFor(accountId: string, privateKey: string): Account {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(privateKey as `ed25519:${string}`));
}

export const relayer = () => accountFor(config.RELAYER_ACCOUNT_ID, config.RELAYER_PRIVATE_KEY);

export async function view<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId: config.ESCROW_CONTRACT_ID, method, args })) as T;
}

export const explorerTx = (hash: string) => `${config.NEAR_EXPLORER_URL}/txns/${hash}`;
export const explorerAccount = (id: string) => `${config.NEAR_EXPLORER_URL}/address/${id}`;

export function txHashOf(res: any): string {
  return res?.transaction?.hash ?? res?.transaction_outcome?.id ?? '';
}
