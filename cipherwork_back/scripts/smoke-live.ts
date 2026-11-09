/**
 * Real end-to-end run: quote -> fund (testnet) -> fresh-nonce TEE preflight -> E2EE private inference
 * -> signature verification -> verifier verdict -> on-chain settlement. Needs NEARAI_API_KEY (see docs/integrations.md).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CipherworkClient } from '../sdk/index.js';
import { accountFor, view } from '../src/near.js';
import { config } from '../src/config.js';

if (!process.env.NEARAI_API_KEY) {
  console.error('NEARAI_API_KEY is not set. Create one at https://cloud.near.ai (API Keys) and add credits, then put it in cipherwork_back/.env.');
  process.exit(3); // never fake a live result
}
const API = process.env.API_URL ?? `http://localhost:${config.PORT}`;
const report = readFileSync(new URL('../../fixtures/fictional_financial_report.txt', import.meta.url), 'utf8');
const expected = JSON.parse(readFileSync(new URL('../../fixtures/expected_result.json', import.meta.url), 'utf8'));

const c = new CipherworkClient({
  apiUrl: API, nearAiApiKey: process.env.NEARAI_API_KEY, buyerAccountId: process.env.DEMO_BUYER_ACCOUNT_ID!, buyerPrivateKey: process.env.DEMO_BUYER_PRIVATE_KEY!,
  onEvent: (e) => console.log(`[${e.step}] ${e.detail ?? ''}`),
});
const out = await c.executePrivateJob({
  offerId: process.argv[2] ?? 'near-ai-glm-5.3-flash',
  messages: [
    { role: 'system', content: 'You are a careful financial analyst. Be concise.' },
    { role: 'user', content: `Analyse this confidential report. List risks and cash headroom over the covenant.\n\n${report}` },
  ],
});
console.log('\n--- answer (stays on this machine; not sent to the API, not stored) ---\n' + out.answer.slice(0, 600) + (out.answer.length > 600 ? '…' : ''));
const lower = out.answer.toLowerCase();
const hits = expected.mustMention.map((m: string) => [m, lower.includes(m.toLowerCase())]);
console.log('\nfixture facts present:', JSON.stringify(Object.fromEntries(hits)));
console.log('signature kind:', out.result.signatureKind, '| signer matches preflight:', out.result.signerMatchesPreflight);
console.log('receipt:', JSON.stringify(out.settled.receipt, null, 1));
for (const k of out.settled.verification.checks) console.log(`  ${k.status.toUpperCase().padEnd(11)} ${k.label}`);

for (const [id, key] of [[config.PROVIDER_ACCOUNT_ID, process.env.PROVIDER_PRIVATE_KEY!], [config.TREASURY_ACCOUNT_ID, config.RELAYER_PRIVATE_KEY]] as const) {
  const bal = await view<string>('get_balance', { account_id: id });
  if (BigInt(bal) > 0n) {
    const r: any = await accountFor(id, key).callFunctionRaw({ contractId: config.ESCROW_CONTRACT_ID, methodName: 'claim_balance', args: {}, gas: 60_000_000_000_000n });
    console.log(`claimed ${bal} for ${id}:`, `${config.NEAR_EXPLORER_URL}/txns/${r.transaction.hash}`);
  }
}
mkdirSync(new URL('../../docs/evidence/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../docs/evidence/smoke-live.receipt.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), receipt: out.settled.receipt, checks: out.settled.verification.checks, signatureKind: out.result.signatureKind }, null, 2));
console.log('\nSMOKE LIVE OK');
