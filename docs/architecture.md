# Architecture

```mermaid
flowchart LR
  B[Buyer browser / SDK] -->|public metadata only| R[API on Railway]
  R --> D[(Postgres: quotes, orders, used nonces)]
  B -->|1. fresh nonce + attestation| T[NEAR AI Cloud TEE]
  B -->|2. E2EE input, only after preflight passes| T
  T -->|signed response| B
  B -->|3. public proof bundle| V[Verifier in API]
  V -->|signed verdict| N[(OrderEscrow on NEAR testnet)]
  B -->|create+fund / refund / claim| N
```

- **Product → Offer → Quote → Order → Receipt**, product `private_ai_inference.v1`.
- Offers are a static registry merged with the live NEAR AI Cloud model catalog. `demo-outage-simulator` is a labelled demo configuration.
- Quote binds `{jobId, offer, model, buyer, provider, maxPay, deadline, contract}` into `quote_digest`, stored on-chain.
- `POST /v1/orders` re-reads the contract and only indexes an order that is Funded and matches the quote. The contract is the source of truth for status.
- `POST /v1/orders/:id/proof` accepts only the allow-listed `ProofBundle` shape (attestations + signature, no text fields).
- Deadline/refund path works with the API offline: the buyer calls `request_refund` on the contract.

See `docs/security-model.md` and `docs/proof-format.md`.
