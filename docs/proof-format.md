# Proof bundle format

Public, sanitized. Contains no prompt, no answer, no API key.

```jsonc
{
  "jobId": "cw_…",
  "offerId": "near-ai-glm-5.3-flash",
  "model": "z-ai/glm-5.3-flash",
  "preflight": {
    "nonce": "<64 hex, client generated>",
    "attestations": [ { "nonce", "signer": {"signingAlgo","signingAddress"}, "intelQuote", "eventLog", "appCompose", "nvidiaPayload?" } ],
    "performedAtMs": 0
  },
  "completion": {
    "completionId": "…",
    "signature": { "kind": "provider_tee", "signer": {…}, "signedText": "<model>:<sha256(request)>:<sha256(response)>", "signature": "…" }
  }
}
```

Field shapes come from `@nearai/inference-sdk` (`ModelAttestation`, `CompletionSignature`), which follows https://docs.near.ai/cloud/verification/.

- `proofDigest = SHA-256(JSON{jobId, model, nonce, signer, tcb, composeHash, osImageHash, signedText, signature})`
- `requestBindingDigest = SHA-256("jobId|offerId|model|nonce|requestHash")`
- Verdict message and signature: see `docs/security-model.md`.
- The verifier does **not** recompute request/response hashes (it never sees the bytes); the SDK does that in the client. The verifier reports this check as `not_checked`.
