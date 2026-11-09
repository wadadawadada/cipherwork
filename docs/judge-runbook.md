# Judge runbook

Prerequisites: Node ≥ 24. Optional: a NEAR AI Cloud API key (https://cloud.near.ai) for the valid-job run.

```bash
git clone <repo> && cd cipherwork
cd cipherwork_back && cp .env.example .env   # fill the testnet values (maintainers provide a demo .env)
npm install && npm test                      # offline security tests (17)
npm run contract:test                        # Rust contract tests (16)
LIVE=1 npx vitest run test/live.test.ts      # real attestation, replay, tamper (no key)
npm start &                                  # API :8787
npm run demo:failure                         # real testnet txs, fail-closed, refund (no key)
NEARAI_API_KEY=… npm run smoke:live          # real private inference + settlement
cd ../cipherwork_front && npm install && npm run dev
```

| Test | Where | Expected |
|---|---|---|
| T01 real attestation | `test/live.test.ts` | verified, no failed checks |
| T02 replay | `test/live.test.ts`, UI "replayed nonce" | rejected, 0 inference POSTs |
| T03 TLS mismatch | not reproducible in browser; Node client binds TLS fingerprint | browser shows NOT VERIFIED |
| T04 tampered signature/quote | `test/security.test.ts`, UI "tampered TDX quote" | verification fails, rejected verdict |
| T05 API leak | `test/security.test.ts` | 400 PRIVATE_FIELD_REJECTED |
| T06 successful order | `npm run smoke:live` | one settlement, 95/5 split |
| T07 double settlement | contract test | second settle panics |
| T08 expiry refund | contract test | buyer refunds without backend |
| T09 provider failure | `test/security.test.ts`, UI demo offer | PROVIDER_UNAVAILABLE |
| T10 fresh checkout | this file | reproducible |
