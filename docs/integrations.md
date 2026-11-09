# Integrations, accounts and API keys

All facts below were checked against live docs on 8 Nov 2026 (https://docs.near.ai/llms.txt, https://docs.near.org/getting-started/faucet).

## 1. NEAR AI Cloud API key (the ONE thing you must create yourself)

Attestation needs **no key**. Private inference does.

1. Sign up: https://cloud.near.ai
2. **Credits** → add credits (the demo uses fractions of a cent per request; `z-ai/glm-5.3-flash` is the cheapest attested chat model).
3. **API Keys** → generate a key.
4. Backend scripts: put it in `cipherwork_back/.env` as `NEARAI_API_KEY=` (used only by `smoke:live` and the CLI).
5. Browser demo: paste it in the "NEAR AI Cloud API key" field. It lives in tab memory and is sent only to `cloud-api.near.ai`.

**Why the key is not in the backend for the web demo:** it must authenticate the buyer→TEE call. If the API server used it, the plaintext would have to pass through Railway - the spec calls that a privacy blocker, so the design is bring-your-own-key in the browser. Server-side use of the key is limited to scripts you run yourself.

Docs: https://docs.near.ai/cloud/quickstart · models https://docs.near.ai/cloud/models · verification https://docs.near.ai/cloud/verification/

## 2. Verified models used

`z-ai/glm-5.3-flash` (default) and `Qwen/Qwen3.8-27B`: both `attestationSupported: true`, provider type `vllm` (NEAR-operated TDX + NVIDIA GPU). The offer list reads the live catalog (`GET https://cloud-api.near.ai/v1/model/list`) and marks an offer unavailable if the model disappears or loses attestation.

## 3. NEAR testnet accounts (created for this project)

Created through the testnet helper (no faucet needed, 10 NEAR each):

| Role | Account |
|---|---|
| Escrow contract + owner | `cipherwork-escrow.testnet` |
| Relayer / treasury (sends verdicts, gets the 5% fee) | `cipherwork-relayer.testnet` |
| Provider payee (operator of the NEAR AI Cloud offer) | `cipherwork-provider.testnet` |
| Demo buyer for scripts | `cipherwork-buyer.testnet` |

Top up: https://near-faucet.io or https://docs.near.org/getting-started/faucet (built-in faucet), or `near create-account <name>.testnet --useFaucet`. Explorer: https://testnet.nearblocks.io. RPC used: `https://test.rpc.fastnear.com` (CORS-enabled; `rpc.testnet.near.org` rate-limits browsers with 429).

## 4. Verifier key

`cd cipherwork_back && npm run keys:generate` prints a new ed25519 seed/public key. The public key is registered in the contract at `new(...)`. Rotation: `set_verifier_key` then `apply_verifier_key` after the timelock.

## 5. Building the contract on Windows

If `link.exe` says `msvcrt.lib` is missing, point `LIB` at a complete MSVC + Windows SDK, and set `AWS_LC_SYS_PREBUILT_NASM=1` for `cargo test` (avoids needing NASM). Wasm build uses `RUSTFLAGS="-C target-cpu=mvp"` (see `scripts/build-contract.mjs`). On Linux/macOS/CI a plain `cargo test` works.

## 6. Railway (not deployed yet - deployment happens only on explicit approval)

Two services from one repo, each with its own root directory:

- **API:** root `cipherwork_back`, add a Postgres plugin, set variables from `.env.example` (`DATABASE_URL=${{Postgres.DATABASE_URL}}`, `CORS_ORIGINS=<front URL>`, `DRIP_ENABLED=true` for the testnet demo).
- **Web:** root `cipherwork_front`, variable `VITE_API_URL=<API public URL>` (build time).

Remove `CONTRACT_OWNER_PRIVATE_KEY` from the running API service after the contract is deployed.

## 7. Hackathon links (re-read before submitting)

https://nearhackathon.com/ · https://nearhackathon.com/HACKATHON.md · https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/03-privacy.md
