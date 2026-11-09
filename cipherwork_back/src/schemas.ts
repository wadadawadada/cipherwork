import { z } from 'zod';

export const PRODUCT_ID = 'private_ai_inference.v1' as const;
export const DOMAIN = 'cipherwork.near.testnet.v1' as const;

/** Field names that must never reach a metadata endpoint (spec §4.1, T05). */
export const FORBIDDEN_FIELDS = [
  'prompt', 'prompts', 'document', 'documents', 'messages', 'message', 'input', 'text', 'content',
  'completion', 'completions', 'response', 'answer', 'file', 'files', 'filename', 'body', 'secret',
  'apikey', 'api_key', 'apiKey', 'privatekey', 'private_key', 'mnemonic', 'seed', 'password', 'authorization',
];

export class PrivateFieldRejected extends Error {
  constructor(public path: string) { super(`Field "${path}" looks like private content and is rejected by this metadata endpoint.`); }
}

/** Deep scan for forbidden keys. Never echoes values. */
export function assertNoPrivateFields(value: unknown, path = '$', depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_FIELDS.includes(k) || FORBIDDEN_FIELDS.includes(k.toLowerCase())) throw new PrivateFieldRejected(`${path}.${k}`);
    assertNoPrivateFields(v, `${path}.${k}`, depth + 1);
  }
}

const yocto = z.string().regex(/^\d{1,40}$/, 'integer yoctoNEAR string');
const nearAccount = z.string().regex(/^[a-z0-9._-]{2,64}$/);
const hex = (n?: number) => z.string().regex(n ? new RegExp(`^[0-9a-f]{${n}}$`) : /^[0-9a-fA-F]+$/);

export const QuoteRequest = z.object({
  productId: z.literal(PRODUCT_ID),
  offerId: z.string().min(3).max(64),
  buyerAccountId: nearAccount,
  maxInputBytes: z.number().int().min(1).max(200_000).default(32_000),
  maxPayYoctoNear: yocto.optional(),
}).strict();

export const OrderCreate = z.object({
  jobId: z.string().min(8).max(64),
  quoteId: z.string().min(8).max(64),
  fundTxHash: z.string().min(40).max(64),
  idempotencyKey: z.string().min(8).max(80).optional(),
}).strict();

const signingAlgo = z.enum(['ecdsa', 'ed25519']);
const identity = z.object({ signingAlgo, signingAddress: z.string().min(40).max(130) }).strict();

const attestation = z.object({
  nonce: hex(64),
  signer: identity,
  intelQuote: z.string().min(100).max(200_000),
  eventLog: z.union([z.string().max(500_000), z.array(z.unknown()).max(5_000)]),
  appCompose: z.string().min(2).max(200_000),
  signingPublicKey: z.string().max(200).optional(),
  nvidiaPayload: z.string().max(2_000_000).optional(),
  reportedQuoteData: z.string().max(400).optional(),
}).strict();

/** Public proof bundle: attestation evidence and a signature. No prompt, no completion text, no key material. */
export const ProofBundle = z.object({
  jobId: z.string().min(8).max(64),
  offerId: z.string().min(3).max(64),
  model: z.string().min(3).max(120),
  preflight: z.object({
    nonce: hex(64),
    attestations: z.array(attestation).min(1).max(8),
    performedAtMs: z.number().int(),
  }).strict(),
  completion: z.object({
    completionId: z.string().min(4).max(200),
    signature: z.object({
      kind: z.enum(['provider_tee', 'gateway']),
      signer: identity,
      signedText: z.string().min(10).max(400),
      signature: z.string().min(40).max(400),
    }).strict(),
  }).strict(),
}).strict();
export type ProofBundle = z.infer<typeof ProofBundle>;

export const ClientReject = z.object({
  reason: z.enum(['ATTESTATION_INVALID', 'TLS_BINDING_UNVERIFIED', 'PROVIDER_UNAVAILABLE', 'QUOTE_EXPIRED']),
  bundle: ProofBundle.optional(),
}).strict();

export type FailureCode =
  | 'POLICY_VIOLATION'
  | 'ATTESTATION_INVALID' | 'TLS_BINDING_UNVERIFIED' | 'MODEL_NOT_ALLOWED' | 'PROVIDER_UNAVAILABLE'
  | 'QUOTE_EXPIRED' | 'VERIFIER_REJECTED' | 'SETTLEMENT_TIMEOUT' | 'ORDER_REFUNDED' | 'PAYMENT_FAILED';

export type OrderStatus = 'quoted' | 'funded' | 'verified' | 'settled' | 'rejected' | 'refunded' | 'expired';

export const AgentPolicySchema = z.object({
  maxPerJobYocto: yocto,
  dailyCapYocto: yocto,
  allowedOffers: z.array(z.string().min(3).max(64)).max(20),
}).strict();

export const AgentRegister = z.object({
  accountId: nearAccount,
  name: z.string().min(2).max(40).regex(/^[\w .-]+$/),
  policy: AgentPolicySchema,
  timestampMs: z.number().int(),
  publicKey: z.string().startsWith('ed25519:').max(80),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
}).strict();

/** Exact text an agent signs with its NEAR key to register or update its spending policy. */
export const agentMessage = (a: { accountId: string; name: string; policy: { maxPerJobYocto: string; dailyCapYocto: string; allowedOffers: string[] }; timestampMs: number }) =>
  `cipherwork.agent.v1|${a.accountId}|${a.name}|${JSON.stringify({ maxPerJobYocto: a.policy.maxPerJobYocto, dailyCapYocto: a.policy.dailyCapYocto, allowedOffers: a.policy.allowedOffers })}|${a.timestampMs}`;
