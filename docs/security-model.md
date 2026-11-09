# Security model

## Boundaries

| Component | Inside the confidential boundary? | Sees plaintext? |
|---|---|---|
| Buyer browser / SDK | yes (trusted) | yes |
| NEAR AI Cloud TEE (attested) | yes | yes (decrypts E2EE fields) |
| CIPHERWORK API on Railway + Postgres | **no** | **no** (strict schemas, forbidden-field guard, redacted logs) |
| NEAR testnet | no | no (metadata only) |

## Pre-disclosure protocol (implemented in `sdk/privateJob.ts`)

1. Fetch the live catalog entry; require `attestationSupported`.
2. `fetchModelAttestations` with a fresh 256-bit client nonce (public endpoint, no key, no user data).
3. For **every** returned candidate: Intel TDX quote via DCAP collateral, accepted TCB status (`UpToDate`, `OutOfDate`), debug off, report data = signer ‖ nonce, RTMR3 event-log replay, MRCONFIGID = SHA-256(app_compose), NVIDIA NRAS GPU evidence when present.
4. Any failure throws `PreflightError`; `runPrivateInference` refuses to run without a successful preflight object for the same model, and refuses fault-injected preflights.
5. Only then does the SDK re-verify gateway + model evidence and send E2EE-encrypted fields to the attested model key.
6. After the response: byte-exact signature verification (`verifyResponse`), signer must match one preflight-verified model report.

## Settlement trust

The contract verifies an ed25519 signature by the authorized verifier over
`cipherwork.near.testnet.v1|<contract>|testnet|<order>|<outcome>|<proof_digest>|<request_binding_digest>|<expiry_ms>`.
Wrong contract, chain, order, outcome, or expiry → rejected. A settled/rejected/refunded order can never settle again (monotonic state). The verifier signs `verified` only after re-verifying the public proof bundle; it signs `rejected` only if it reproduces the failure itself.
Honest label everywhere: **Trust: CIPHERWORK authorized verifier.**

## Contract invariants (tested)

No double settlement or refund; integer yocto math; fee only on success, capped at 10%; storage fee charged from the deposit; refund after deadline by the buyer alone (no backend); pull payments with balance zeroed before transfer and restored on failure; verifier key rotation is timelocked; events carry no plaintext.

## Not protected

Wrong/inaccurate model output, a compromised browser or OS, provider retention beyond what is provable, public wallet/transaction metadata, availability failures, collusion with the verifier, TEE firmware or vendor-root weaknesses.

## Logging

Fastify logs `method + path` only (no query, headers or bodies). Rejected private fields are logged as a code and JSON path, never the value (tested). The browser keeps input and answer in React state only; the burner testnet key is the only thing in localStorage.
