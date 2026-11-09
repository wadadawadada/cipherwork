import { createHash, createPrivateKey, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto';
import {
  createGpuEvidenceVerifier,
  createTdxQuoteVerifier,
  findModelAttestationForSignature,
  verifyModelAttestation,
  type VerifiedModelAttestation,
  type ModelAttestation,
} from '@nearai/inference-sdk/node';
import { verifyMessage } from 'ethers';
import { config } from './config.js';
import { DOMAIN, type ProofBundle, type FailureCode } from './schemas.js';
import { VERIFICATION_POLICY } from './offers.js';

export type Check = { id: string; label: string; status: 'passed' | 'failed' | 'not_checked'; detail?: string };

export type VerifierResult = {
  ok: boolean;
  failureCode?: FailureCode;
  checks: Check[];
  proofDigest?: string;
  requestBindingDigest?: string;
  signer?: { signingAlgo: string; signingAddress: string };
  tcbStatus?: string;
};

export type Verdict = {
  order_id: string;
  outcome: 'verified' | 'rejected';
  proof_digest: string;
  request_binding_digest: string;
  expiry_ms: number;
  verifier_key_id: string;
};

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

// ---- verifier signing key (ed25519, seed from backend environment only) ----
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const signingKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(config.VERIFIER_SEED_HEX, 'hex')]), format: 'der', type: 'pkcs8' });

export function verdictMessage(contractId: string, v: Verdict): string {
  return [DOMAIN, contractId, 'testnet', v.order_id, v.outcome, v.proof_digest, v.request_binding_digest, v.expiry_ms].join('|');
}

export function signVerdict(v: Verdict): string {
  return edSign(null, Buffer.from(verdictMessage(config.ESCROW_CONTRACT_ID, v)), signingKey).toString('hex');
}

export function verifyVerdictSignature(contractId: string, v: Verdict, sigHex: string, pubHex = config.VERIFIER_PUBLIC_KEY_HEX): boolean {
  const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
  return edVerify(null, Buffer.from(verdictMessage(contractId, v)), pub, Buffer.from(sigHex, 'hex'));
}

export function makeVerdict(orderId: string, outcome: 'verified' | 'rejected', proofDigest: string, requestBindingDigest: string, ttlMs = 5 * 60_000): Verdict {
  return {
    order_id: orderId,
    outcome,
    proof_digest: proofDigest,
    request_binding_digest: requestBindingDigest,
    expiry_ms: Date.now() + ttlMs,
    verifier_key_id: config.VERIFIER_KEY_ID,
  };
}

type Deps = { tdxQuote?: ReturnType<typeof createTdxQuoteVerifier>; gpu?: ReturnType<typeof createGpuEvidenceVerifier> };

/** Verifies a PUBLIC proof bundle. The verifier never sees prompt or completion bytes. */
export async function verifyProofBundle(
  bundle: ProofBundle,
  expect: { jobId: string; offerId: string; model: string },
  deps: Deps = {},
): Promise<VerifierResult> {
  const checks: Check[] = [];
  const fail = (id: string, label: string, detail: string, code: FailureCode): VerifierResult => {
    checks.push({ id, label, status: 'failed', detail });
    return { ok: false, failureCode: code, checks };
  };

  if (bundle.jobId !== expect.jobId || bundle.offerId !== expect.offerId || bundle.model !== expect.model) {
    return fail('binding', 'Bundle matches job, offer and model', 'jobId / offerId / model mismatch', 'MODEL_NOT_ALLOWED');
  }
  checks.push({ id: 'binding', label: 'Bundle matches job, offer and model', status: 'passed' });

  const nonce = bundle.preflight.nonce.toLowerCase();
  const tdxQuote = deps.tdxQuote ?? createTdxQuoteVerifier();
  const gpuEvidence = deps.gpu ?? createGpuEvidenceVerifier();
  const verified: VerifiedModelAttestation[] = [];
  const errors: string[] = [];
  for (const a of bundle.preflight.attestations) {
    try {
      if (a.nonce.toLowerCase() !== nonce) throw new Error('attestation nonce differs from bundle nonce');
      const v = await verifyModelAttestation({
        attestation: a as ModelAttestation,
        clientBinding: { nonce },
        policy: { acceptedTcbStatuses: [...VERIFICATION_POLICY.acceptedTcbStatuses], gpuEvidence: 'if-present' },
        verifiers: { tdxQuote, gpuEvidence },
      });
      verified.push(v);
    } catch (e: any) {
      errors.push(e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e));
    }
  }
  if (verified.length === 0) {
    return fail('attestation', 'TDX quote, nonce, signer, RTMR3, MRCONFIGID, GPU evidence', errors.join('; ') || 'no verified attestation', 'ATTESTATION_INVALID');
  }
  if (errors.length) {
    // Spec: verify EVERY candidate. A failing candidate fails closed.
    return fail('attestation', 'Every returned attestation candidate verifies', errors.join('; '), 'ATTESTATION_INVALID');
  }
  checks.push({ id: 'attestation', label: 'TDX quote, nonce freshness, signer binding, RTMR3 replay, MRCONFIGID, GPU evidence', status: 'passed', detail: `${verified.length} candidate(s), TCB ${verified[0].tcbStatus}` });

  const sig = bundle.completion.signature;
  if (sig.kind !== 'provider_tee') {
    return fail('sigkind', 'Signature kind is provider_tee', `got ${sig.kind}; a gateway signature does not bind a model TEE`, 'VERIFIER_REJECTED');
  }
  checks.push({ id: 'sigkind', label: 'Signature kind is provider_tee', status: 'passed' });

  let matched: VerifiedModelAttestation;
  try {
    matched = findModelAttestationForSignature({ attestations: verified, signature: { kind: sig.kind, signer: sig.signer } });
  } catch (e: any) {
    return fail('signer', 'Signature signer matches exactly one verified model report', String(e?.message ?? e), 'VERIFIER_REJECTED');
  }
  checks.push({ id: 'signer', label: 'Signature signer matches exactly one verified model report', status: 'passed' });

  const sigOk = (() => {
    try {
      if (sig.signer.signingAlgo === 'ecdsa') {
        return verifyMessage(sig.signedText, sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`).toLowerCase().replace(/^0x/, '') === sig.signer.signingAddress.toLowerCase().replace(/^0x/, '');
      }
      const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(sig.signer.signingAddress, 'hex')]), format: 'der', type: 'spki' });
      return edVerify(null, Buffer.from(sig.signedText, 'utf8'), pub, Buffer.from(sig.signature.replace(/^0x/, ''), 'hex'));
    } catch { return false; }
  })();
  if (!sigOk) return fail('signature', 'Response signature is cryptographically valid for the attested signer', 'signature does not verify', 'VERIFIER_REJECTED');
  checks.push({ id: 'signature', label: 'Response signature is cryptographically valid for the attested signer', status: 'passed' });

  const parts = sig.signedText.split(':');
  const [textModel, requestHash, responseHash] = [parts.slice(0, -2).join(':'), parts.at(-2) ?? '', parts.at(-1) ?? ''];
  if (textModel !== expect.model || !HEX64.test(requestHash) || !HEX64.test(responseHash)) {
    return fail('payload', 'Signed text is <model>:<request_hash>:<response_hash> for the ordered model', `signed text model "${textModel}"`, 'MODEL_NOT_ALLOWED');
  }
  checks.push({ id: 'payload', label: 'Signed text is <model>:<request_hash>:<response_hash> for the ordered model', status: 'passed' });
  checks.push({
    id: 'bytes',
    label: 'Exact request/response bytes hashed into the signature',
    status: 'not_checked',
    detail: 'The verifier never receives plaintext, so byte-exact hashing is verified client-side by the SDK. This is a documented weaker check.',
  });

  const proofDigest = sha256hex(JSON.stringify({
    v: 1, jobId: expect.jobId, model: expect.model, nonce,
    signer: matched.signer, tcb: matched.tcbStatus, composeHash: matched.deployment.runtimeMeasurements.composeHash ?? null,
    osImageHash: matched.deployment.runtimeMeasurements.osImageHash ?? null,
    signedText: sig.signedText, signature: sig.signature,
  }));
  const requestBindingDigest = sha256hex(`${expect.jobId}|${expect.offerId}|${expect.model}|${nonce}|${requestHash}`);
  return { ok: true, checks, proofDigest, requestBindingDigest, signer: matched.signer, tcbStatus: matched.tcbStatus };
}
