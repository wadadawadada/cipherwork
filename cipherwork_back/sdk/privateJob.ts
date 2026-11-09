/**
 * Isomorphic core of the buyer-side workflow (runs in Node and in the browser).
 * Copied verbatim to cipherwork_front/src/lib/privateJob.ts - keep the two files identical.
 *
 * Guarantee implemented here: runPrivateInference() REFUSES to run unless a successful
 * preflight object (fresh nonce, every attestation candidate verified) is passed in.
 * The preflight itself sends no user data: it only requests public attestation reports.
 */

type Sdk = typeof import('@nearai/inference-sdk');

export type CheckStatus = 'passed' | 'failed' | 'not_checked';
export type PreflightCheck = { id: string; label: string; status: CheckStatus; detail?: string };

export type FaultInjection = 'none' | 'wrong_nonce' | 'tampered_quote';

export type Preflight = {
  ok: true;
  model: string;
  nonce: string;
  performedAtMs: number;
  attestations: any[]; // raw public evidence (no user data)
  verified: any[];
  checks: PreflightCheck[];
  tlsBinding: 'attested' | 'none';
  injected: FaultInjection;
};

export class PreflightError extends Error {
  code: 'ATTESTATION_INVALID' | 'TLS_BINDING_UNVERIFIED' | 'MODEL_NOT_ALLOWED' | 'PROVIDER_UNAVAILABLE';
  checks: PreflightCheck[];
  attestations: any[];
  nonce: string;
  constructor(code: PreflightError['code'], message: string, checks: PreflightCheck[], attestations: any[] = [], nonce = '') {
    super(message);
    this.code = code;
    this.checks = checks;
    this.attestations = attestations;
    this.nonce = nonce;
  }
}

/** Browsers cannot call NVIDIA NRAS directly (CORS). A relay forwards public GPU evidence; this adds a documented trust hop. */
export type GpuRelay = { nrasUrl?: string; jwksUrl?: string };

export const ACCEPTED_TCB = ['UpToDate', 'OutOfDate'] as const;
export const randomNonceHex = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export async function preflight(
  sdk: Sdk,
  opts: { baseUrl: string; model: string; fault?: FaultInjection; onCheck?: (c: PreflightCheck) => void; gpu?: GpuRelay },
): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const push = (c: PreflightCheck) => {
    checks.push(c);
    opts.onCheck?.(c);
  };
  const fault = opts.fault ?? 'none';
  const client = new sdk.AttestationClient({ baseUrl: opts.baseUrl, headers: {} });

  let meta: any;
  try {
    meta = await client.fetchModelMetadata(opts.model);
  } catch (e: any) {
    push({ id: 'catalog', label: 'Model found in the live NEAR AI Cloud catalog', status: 'failed', detail: String(e?.message ?? e) });
    throw new PreflightError('PROVIDER_UNAVAILABLE', 'Model catalog lookup failed', checks);
  }
  if (!meta?.attestationSupported) {
    push({ id: 'catalog', label: 'Model supports TEE attestation', status: 'failed', detail: `providerType=${meta?.providerType}` });
    throw new PreflightError('MODEL_NOT_ALLOWED', 'Model does not support attestation', checks);
  }
  push({ id: 'catalog', label: 'Model supports TEE attestation (live catalog)', status: 'passed', detail: `providerType=${meta.providerType}` });

  let fetched: Awaited<ReturnType<typeof client.fetchModelAttestations>>;
  try {
    fetched = await client.fetchModelAttestations({ model: opts.model, signingAlgo: 'ed25519' });
  } catch (e: any) {
    push({ id: 'fetch', label: 'Fetch attestation report with fresh nonce', status: 'failed', detail: String(e?.message ?? e) });
    throw new PreflightError('PROVIDER_UNAVAILABLE', 'Attestation endpoint unavailable', checks);
  }
  let attestations: any[] = fetched.attestations.map((a) => ({ ...a }));
  let nonce = fetched.clientBinding.nonce;
  push({ id: 'nonce', label: 'Fresh 256-bit client nonce generated and echoed', status: 'passed', detail: `${nonce.slice(0, 16)}…` });
  push({ id: 'fetch', label: `Fetched ${attestations.length} model attestation candidate(s)`, status: attestations.length ? 'passed' : 'failed' });
  if (!attestations.length) throw new PreflightError('ATTESTATION_INVALID', 'No attestation candidates returned', checks);

  // Clearly flagged test fixtures (never used in the real flow): the verifier must reject them.
  if (fault === 'wrong_nonce') {
    nonce = randomNonceHex(); // verifier is told a different nonce than the quote contains -> replay
    push({ id: 'fault', label: 'TEST FIXTURE: expected nonce replaced (simulates a replayed report)', status: 'not_checked' });
  }
  if (fault === 'tampered_quote') {
    attestations = attestations.map((a) => ({ ...a, intelQuote: a.intelQuote.slice(0, 200) + (a.intelQuote[200] === 'a' ? 'b' : 'a') + a.intelQuote.slice(201) }));
    push({ id: 'fault', label: 'TEST FIXTURE: one byte of the TDX quote altered', status: 'not_checked' });
  }

  const verifiers = { tdxQuote: sdk.createTdxQuoteVerifier(), gpuEvidence: sdk.createGpuEvidenceVerifier(opts.gpu) };
  const verified: any[] = [];
  for (const [i, a] of attestations.entries()) {
    try {
      const v = await sdk.verifyModelAttestation({
        attestation: a,
        clientBinding: { nonce },
        policy: { acceptedTcbStatuses: [...ACCEPTED_TCB], gpuEvidence: 'if-present' },
        verifiers,
      });
      verified.push(v);
      push({ id: `quote-${i}`, label: 'Intel TDX quote verified (DCAP collateral, TCB policy, debug off)', status: 'passed', detail: `TCB ${v.tcbStatus}` });
      push({ id: `bind-${i}`, label: 'Report data binds signer + your nonce', status: 'passed', detail: `${v.signer.signingAlgo}:${v.signer.signingAddress.slice(0, 14)}…` });
      push({ id: `rtmr-${i}`, label: 'RTMR3 event-log replay and MRCONFIGID = SHA-256(app_compose)', status: 'passed' });
      push({ id: `gpu-${i}`, label: 'NVIDIA GPU evidence (NRAS)', status: v.gpuEvidence === 'verified' ? 'passed' : 'not_checked', detail: v.gpuEvidence + (opts.gpu?.nrasUrl ? ' - via CIPHERWORK relay of NVIDIA NRAS (browser CORS); the independent verifier re-checks NRAS directly' : '') });
    } catch (e: any) {
      const detail = e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
      push({ id: `quote-${i}`, label: 'Attestation candidate verification', status: 'failed', detail });
      throw new PreflightError('ATTESTATION_INVALID', `Attestation rejected: ${detail}`, checks, attestations, nonce);
    }
  }
  push({
    id: 'tls',
    label: 'Gateway TLS endpoint binding',
    status: 'not_checked',
    detail: 'Browser fetch cannot read the TLS peer certificate. The CLI/SDK (Node) performs this check. Channel is NOT marked end-to-end TLS-verified here; message fields are instead E2EE-encrypted to the attested model key.',
  });
  return { ok: true, model: opts.model, nonce, performedAtMs: Date.now(), attestations, verified, checks, tlsBinding: 'none', injected: fault };
}

export type PrivateResult = {
  answer: string;
  completionId: string;
  signatureKind: string;
  signature: { kind: 'provider_tee' | 'gateway'; signer: { signingAlgo: string; signingAddress: string }; signedText: string; signature: string };
  signerMatchesPreflight: boolean;
  usage?: unknown;
};

/** The ONLY place user text leaves the client. Requires a successful Preflight object. */
export async function runPrivateInference(
  sdk: Sdk | any,
  opts: {
    baseUrl: string; apiKey: string; model: string; preflight: Preflight; messages: { role: 'system' | 'user'; content: string }[];
    maxTokens?: number; clientOptions?: Record<string, unknown>; gpu?: GpuRelay;
  },
): Promise<PrivateResult> {
  if (!opts.preflight || opts.preflight.ok !== true || opts.preflight.model !== opts.model) {
    throw new PreflightError('ATTESTATION_INVALID', 'Refusing to send: no successful preflight for this model', []);
  }
  if (opts.preflight.injected !== 'none') throw new PreflightError('ATTESTATION_INVALID', 'Refusing to send: preflight used a fault-injection fixture', []);
  const client = new sdk.InferenceClient({
    baseUrl: opts.baseUrl, apiKey: opts.apiKey, e2ee: true, signingAlgo: 'ed25519', ...(opts.clientOptions ?? {}),
    gatewayVerification: { ...(opts.clientOptions as any)?.gatewayVerification, policy: { acceptedTcbStatuses: [...ACCEPTED_TCB] } },
    modelVerification: { policy: { acceptedTcbStatuses: [...ACCEPTED_TCB], gpuEvidence: 'if-present' }, ...(opts.gpu ? { verifiers: { gpuEvidence: sdk.createGpuEvidenceVerifier(opts.gpu) } } : {}) },
  });
  await client.verify(opts.model); // SDK re-verifies gateway + model evidence before any encrypted payload leaves
  const completion: any = await client.chat.completions.create({ model: opts.model, messages: opts.messages, max_tokens: opts.maxTokens ?? 4000 });
  const verified: any = await client.verifyResponse(completion.id);
  const signer = verified.signature.signer;
  const match = opts.preflight.verified.some((v) => v.signer.signingAddress === signer.signingAddress && v.signer.signingAlgo === signer.signingAlgo);
  return {
    answer: completion.choices?.[0]?.message?.content || completion.choices?.[0]?.message?.reasoning_content || `(empty answer; finish_reason=${completion.choices?.[0]?.finish_reason})`,
    completionId: completion.id,
    signatureKind: verified.signatureKind,
    signature: verified.signature,
    signerMatchesPreflight: match,
    usage: completion.usage,
  };
}

/** Public, sanitized proof bundle: attestation evidence + signature. No prompt, no answer. */
export function buildProofBundle(args: { jobId: string; offerId: string; model: string; preflight: Preflight; result: PrivateResult }) {
  const { jobId, offerId, model, preflight, result } = args;
  return {
    jobId, offerId, model,
    preflight: { nonce: preflight.nonce, attestations: preflight.attestations, performedAtMs: preflight.performedAtMs },
    completion: { completionId: result.completionId, signature: result.signature },
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
