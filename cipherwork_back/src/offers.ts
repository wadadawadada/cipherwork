import { config } from './config.js';
import { PRODUCT_ID } from './schemas.js';

export type Offer = {
  id: string;
  productId: typeof PRODUCT_ID;
  providerId: string;
  providerAccountId: string;
  modelId: string;
  maxInputBytes: number;
  maxCostYoctoNear: string;
  pricingUnit: 'request';
  verificationPolicyId: string;
  timeoutMs: number;
  status: 'available' | 'unavailable' | 'degraded';
  kind: 'real' | 'demo';
  label: string;
  note: string;
};

const NEAR = 10n ** 24n;
const near = (milli: number) => ((BigInt(milli) * NEAR) / 1000n).toString();

export const VERIFICATION_POLICY = {
  id: 'near-ai-cloud-tdx-v1',
  version: '1.0',
  description:
    'Fresh client nonce; Intel TDX quote verified against DCAP collateral; accepted TCB status set; debug mode off; report data binds signer + nonce; RTMR3 event-log replay; MRCONFIGID = SHA-256(app_compose); NVIDIA NRAS GPU evidence when present; provider_tee response signature must match exactly one verified model report.',
  acceptedTcbStatuses: ['UpToDate', 'OutOfDate'] as const,
  gpuEvidence: 'if-present',
  requiredSignatureKind: 'provider_tee',
  notVerified: [
    'Semantic correctness of the model answer',
    'Provider data-retention policy (documented, not technically verified)',
    'That the attested instance is the one serving this exact request (instances of a model share one signing key)',
    'Gateway TLS binding in the browser (browser Fetch cannot read the peer certificate; the CLI verifies it)',
  ],
};

/** Static registry. Live availability is merged in from the NEAR AI Cloud model list (see liveOffers). */
export const OFFERS: Offer[] = [
  {
    id: 'near-ai-glm-5.3-flash',
    productId: PRODUCT_ID,
    providerId: 'near-ai-cloud',
    providerAccountId: config.PROVIDER_ACCOUNT_ID,
    modelId: 'z-ai/glm-5.3-flash',
    maxInputBytes: 32_000,
    maxCostYoctoNear: near(20),
    pricingUnit: 'request',
    verificationPolicyId: VERIFICATION_POLICY.id,
    timeoutMs: 120_000,
    status: 'available',
    kind: 'real',
    label: 'GLM 5.3 Flash (TEE)',
    note: 'Real NEAR AI Cloud TEE model. Fast and cheap; the default for the demo.',
  },
  {
    id: 'near-ai-qwen3.8-27b',
    productId: PRODUCT_ID,
    providerId: 'near-ai-cloud',
    providerAccountId: config.PROVIDER_ACCOUNT_ID,
    modelId: 'Qwen/Qwen3.8-27B',
    maxInputBytes: 32_000,
    maxCostYoctoNear: near(30),
    pricingUnit: 'request',
    verificationPolicyId: VERIFICATION_POLICY.id,
    timeoutMs: 120_000,
    status: 'available',
    kind: 'real',
    label: 'Qwen 3.8 27B (TEE)',
    note: 'Real NEAR AI Cloud TEE model. Same operator as the other real offer, so it is not an independent supplier.',
  },
  {
    id: 'demo-outage-simulator',
    productId: PRODUCT_ID,
    providerId: 'demo-simulator',
    providerAccountId: config.PROVIDER_ACCOUNT_ID,
    modelId: 'z-ai/glm-5.3-flash',
    maxInputBytes: 32_000,
    maxCostYoctoNear: near(10),
    pricingUnit: 'request',
    verificationPolicyId: VERIFICATION_POLICY.id,
    timeoutMs: 5_000,
    status: 'unavailable',
    kind: 'demo',
    label: 'DEMO: outage simulator',
    note: 'Demo configuration, not a real supplier. Always reports unavailable to illustrate selection and PROVIDER_UNAVAILABLE.',
  },
];

let cache: { at: number; ids: Set<string> | null } = { at: 0, ids: null };

/** Reads the live model catalog; marks real offers unavailable when the model is gone or not attestable. */
export async function liveOffers(): Promise<Offer[]> {
  if (!cache.ids || Date.now() - cache.at > 60_000) {
    try {
      const r = await fetch(`${config.NEAR_AI_BASE_URL}/model/list`, { signal: AbortSignal.timeout(8000) });
      const j: any = await r.json();
      cache = {
        at: Date.now(),
        ids: new Set<string>(j.models.filter((m: any) => m.metadata?.attestationSupported).map((m: any) => m.modelId)),
      };
    } catch {
      cache = { at: Date.now(), ids: null };
    }
  }
  return OFFERS.map((o) => {
    if (o.kind === 'demo') return o;
    if (!cache.ids) return { ...o, status: 'degraded' as const };
    return { ...o, status: cache.ids.has(o.modelId) ? ('available' as const) : ('unavailable' as const) };
  });
}
