import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8787),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional().default(''),
  NEAR_NETWORK: z.literal('testnet').default('testnet'),
  NEAR_RPC_URL: z.string().url().default('https://test.rpc.fastnear.com'),
  NEAR_EXPLORER_URL: z.string().url().default('https://testnet.nearblocks.io'),
  ESCROW_CONTRACT_ID: z.string().min(2),
  RELAYER_ACCOUNT_ID: z.string().min(2),
  RELAYER_PRIVATE_KEY: z.string().startsWith('ed25519:'),
  TREASURY_ACCOUNT_ID: z.string().min(2),
  FEE_BPS: z.coerce.number().int().min(0).max(1000).default(500),
  VERIFIER_KEY_ID: z.string().min(1),
  VERIFIER_SEED_HEX: z.string().regex(/^[0-9a-f]{64}$/i),
  VERIFIER_PUBLIC_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/i),
  PROVIDER_ACCOUNT_ID: z.string().min(2),
  NEAR_AI_BASE_URL: z.string().url().default('https://cloud-api.near.ai/v1'),
  // Optional: public-attestation requests work without a key. The API server never forwards user input.
  NEARAI_API_KEY: z.string().optional().default(''),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
