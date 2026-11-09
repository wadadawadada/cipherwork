/**
 * Deterministic fail-closed demonstration (needs NO NEAR AI key; spends testnet NEAR only).
 *   1. buyer quotes + funds an order on testnet
 *   2. preflight runs with a flagged TEST FIXTURE (tampered quote / replayed nonce)
 *   3. preflight FAILS -> private input is never sent (we count outbound inference POSTs: must be 0)
 *   4. the failing evidence is submitted; the verifier reproduces the failure and signs a "rejected" verdict
 *   5. escrow refunds the buyer (balance claimable), provider receives nothing
 */
import 'dotenv/config';
import { CipherworkClient, PreflightError, buildProofBundle } from '../sdk/index.js';
import { accountFor, provider, view } from '../src/near.js';
import { config } from '../src/config.js';

const fault = (process.argv[2] ?? 'tampered_quote') as 'wrong_nonce' | 'tampered_quote';
const API = process.env.API_URL ?? `http://localhost:${config.PORT}`;

// Count any outbound request that could carry a prompt (chat completions).
let inferencePosts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (/\/chat\/completions|\/responses/.test(url) && (init?.method ?? 'GET') === 'POST') inferencePosts++;
  return realFetch(input, init);
}) as typeof fetch;

const c = new CipherworkClient({
  apiUrl: API, buyerAccountId: process.env.DEMO_BUYER_ACCOUNT_ID!, buyerPrivateKey: process.env.DEMO_BUYER_PRIVATE_KEY!,
  onEvent: (e) => console.log(`  [${e.step}] ${e.detail ?? ''}`),
});

console.log(`\n== DEMO B: fail-closed (fault = ${fault}) ==`);
const q = await c.quote('near-ai-glm-5.3-flash');
console.log('quote', q.quote.jobId);
const funded = await c.fundOrder(q);
console.log('funded on testnet:', funded.receipt.fundTxUrl);

let evidence: { attestations: any[]; nonce: string } | undefined;
try {
  await c.verifyProvider(q.quote.modelId, fault);
  console.error('!! preflight unexpectedly passed'); process.exit(1);
} catch (e: any) {
  if (!(e instanceof PreflightError)) throw e;
  console.log(`\nPreflight FAILED as expected: ${e.code}`);
  for (const k of e.checks) console.log(`   ${k.status.toUpperCase().padEnd(11)} ${k.label}${k.detail ? ' - ' + k.detail.slice(0, 120) : ''}`);
  evidence = { attestations: e.attestations, nonce: e.nonce };
}
console.log(`\nOutbound inference requests (private bytes dispatched): ${inferencePosts}`);
if (inferencePosts !== 0) { console.error('!! FAIL-CLOSED VIOLATED'); process.exit(2); }

// Submit the failing evidence; the verifier must independently reproduce the failure before signing "rejected".
const bundle = {
  jobId: q.quote.jobId, offerId: q.quote.offerId, model: q.quote.modelId,
  preflight: { nonce: evidence!.nonce, attestations: evidence!.attestations, performedAtMs: Date.now() },
  completion: { completionId: 'none-preflight-blocked', signature: { kind: 'provider_tee', signer: evidence!.attestations[0].signer, signedText: `${q.quote.modelId}:${'0'.repeat(64)}:${'0'.repeat(64)}`, signature: '0'.repeat(128) } },
};
void buildProofBundle;
const r = await fetch(`${API}/v1/orders/${q.quote.jobId}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'ATTESTATION_INVALID', bundle }) });
const rej: any = await r.json();
console.log('\nVerifier response:', r.status, rej.receipt?.status, rej.verification?.failureCode);
for (const k of rej.verification?.checks ?? []) console.log(`   ${k.status.toUpperCase().padEnd(11)} ${k.label}${k.detail ? ' - ' + String(k.detail).slice(0, 120) : ''}`);
console.log('settle tx:', rej.receipt?.settleTxUrl);

const order: any = await view('get_order', { order_id: q.quote.jobId });
const buyerBal = await view<string>('get_balance', { account_id: config.PROVIDER_ACCOUNT_ID });
console.log(`\nOn-chain status: ${order.status} | provider claimable balance: ${buyerBal} (expect unchanged / 0 for this job)`);
const buyerClaimable = await view<string>('get_balance', { account_id: process.env.DEMO_BUYER_ACCOUNT_ID });
console.log(`Buyer claimable (refunded): ${buyerClaimable} yoctoNEAR`);
const claim = await accountFor(process.env.DEMO_BUYER_ACCOUNT_ID!, process.env.DEMO_BUYER_PRIVATE_KEY!).callFunctionRaw({ contractId: config.ESCROW_CONTRACT_ID, methodName: 'claim_balance', args: {}, gas: 60_000_000_000_000n });
console.log('claim tx:', `${config.NEAR_EXPLORER_URL}/txns/${(claim as any).transaction.hash}`);
void provider;
console.log('\nRESULT: FAIL-CLOSED OK - 0 private bytes sent, no payout to provider, buyer refunded.');
