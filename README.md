# CIPHERWORK - Private work. Public proof.

> Built for NEAR HACKATHON 2026 - Privacy & Private AI. Testnet MVP. No token.

CIPHERWORK lets a buyer (a person or an AI agent) buy confidential AI inference **without handing private input to the marketplace or to an unverified server**.
The client verifies the NEAR AI Cloud TEE (fresh nonce, Intel TDX quote, GPU evidence) *before* sending anything, sends the input end-to-end encrypted straight to the attested model, checks the signed response, and pays through a NEAR testnet escrow contract that settles only on a verifier-signed verdict.

**Live demo (NEAR testnet):** https://cipherwork-production.up.railway.app - API: https://cipherwork-api-production.up.railway.app/health

**Ten-second version:** your agent checks the secure hardware, gets the result, and pays on NEAR. The marketplace API never sees the document.

```
Buyer (browser / SDK) ──public metadata──▶ API (Railway) ──▶ Postgres (orders only)
        │  ▲                                    │
        │  └──── quotes / receipts ─────────────┘
        ├── 1. fresh-nonce attestation ──▶ NEAR AI Cloud TEE  (verified in the client)
        ├── 2. E2EE private input  ──────▶ NEAR AI Cloud TEE  (only after step 1 passes)
        ├── 3. public proof bundle ──────▶ API verifier ──signed verdict──▶ NEAR escrow contract
        └── fund / refund ───────────────────────────────────────────────▶ NEAR escrow contract
```

## Repository layout

| Path | What | Deploys to |
|---|---|---|
| `cipherwork_front/` | React + Vite + Tailwind console (landing, live demo, verification model, dev docs) | Railway service 1 |
| `cipherwork_back/` | Fastify API, verifier, TypeScript SDK/CLI, Rust escrow contract, scripts, tests | Railway service 2 (+ Postgres) |
| `cipherwork_back/contracts/order-escrow/` | Rust `near-sdk` escrow (testnet) | NEAR testnet |
| `fixtures/` | Fictional financial report + expected facts + labelled fault fixtures | - |
| `docs/` | architecture, security model, proof format, integrations, judge runbook | - |

All secrets live in the **backend** environment (`cipherwork_back/.env`, see `.env.example`). The frontend has no secrets; it only needs `VITE_API_URL`.

> CI: the workflow is kept at `docs/ci.workflow.yml`; copy it to `.github/workflows/ci.yml` to enable GitHub Actions.

## Quick start (local)

Requirements: Node ≥ 24, Rust (only to rebuild the contract).

```bash
# terminal 1 - API (uses the committed testnet contract; copy .env.example to .env and fill it in)
cd cipherwork_back && npm install && npm start      # http://localhost:8787
# terminal 2 - web
cd cipherwork_front && npm install && npm run dev   # http://127.0.0.1:5173
```

## Judge walkthrough - do X → see Y

1. **Open** `http://127.0.0.1:5173/#console`. **See** the offers (two real NEAR AI Cloud TEE models, one clearly labelled DEMO outage simulator that is `UNAVAILABLE`).
2. **Click** `Get testnet NEAR`. **See** your in-browser burner wallet receive 1 testnet NEAR (real transaction link).
3. **Select** `Failure test: tampered TDX quote` → `Run failure test`. **See** the testnet order funded, the preflight **FAILED** with the exact check, `Private bytes dispatched: 0`, then an independent verifier verdict `rejected`, and a refund you can claim. No payout to the provider.
4. **Paste** a NEAR AI Cloud API key (see `docs/integrations.md`), select `Valid job`, `Fund, verify and run privately`. **See** each attestation check listed with its own VERIFIED / NOT VERIFIED badge, the answer, the signature check, an on-chain settlement transaction, and the receipt.
5. **Inspect** the right-hand panels. **See** `Plaintext → CIPHERWORK API: 0 B`, the outbound request log, and the exact public payloads the API received (no source text).
6. **CLI:** `cd cipherwork_back && npm run demo:failure` (no API key needed) and `npm run smoke:live` (needs `NEARAI_API_KEY`).
7. **Tests:** `npm test` (offline security tests), `npm run contract:test` (16 contract tests), `LIVE=1 npx vitest run test/live.test.ts` (real attestation, replay, tamper).

## What is private, public and trusted

- **Private:** the input text and the model answer. They travel only between the buyer and the NEAR AI Cloud TEE (E2EE to the attested model key). They never touch this API, its logs, Postgres or the chain.
- **Public:** order metadata (buyer/provider accounts, amount, deadline, proof digest) on NEAR testnet and in the API. **NEAR payments are public - this is not private settlement.**
- **Trusted:** Intel/NVIDIA hardware roots, NEAR AI Cloud as model operator, and **one CIPHERWORK authorized verifier key** (the contract does *not* verify TDX on-chain). See `docs/security-model.md`.

## Implementation status (evidence-based)

| Feature | Status |
|---|---|
| Fresh-nonce TDX + GPU attestation verification (official `@nearai/inference-sdk`) | **tested live** (`LIVE=1` tests, browser, CLI) |
| Invalid proof blocks all disclosure (tampered quote, replayed nonce) | **tested live**, in browser and `npm run demo:failure` |
| Escrow contract: create/fund/settle/refund/claim, signer & replay checks | **tested** (16 unit tests) and **deployed to testnet** |
| Verifier verdict → on-chain settlement of a *rejected* order + buyer refund | **tested live on testnet** |
| Real private inference + signed response + `verified` settlement + 95/5 split + claims | **tested live on testnet** (`npm run smoke:live`, receipt in `docs/evidence/smoke-live.receipt.json`) |
| Gateway TLS binding | CLI/SDK (Node) only; browser fetch cannot read the peer cert → shown as NOT VERIFIED |
| GPU evidence in the browser | goes through a labelled relay of NVIDIA NRAS (CORS); verifier re-checks directly |
| Wallet | in-browser testnet burner wallet; wallet-selector connector is not implemented |
| Second independent provider, fallback, x402, stablecoins, OutLayer | not implemented (P1/P2) |

## Known limits

- Nonce freshness is asserted by the client; the verifier checks the nonce is bound in the quote and rejects nonce reuse across jobs.
- The verifier never receives plaintext, so byte-exact request/response hashing is verified client-side by the SDK (shown as NOT VERIFIED on the verifier side).
- Provider retention policy of NEAR AI Cloud cannot be technically verified here.
- Unaudited hackathon code. Testnet only.

License: MIT.
