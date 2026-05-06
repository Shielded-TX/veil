# Veil

A privacy-first compliant shielded stablecoin built on Aztec Network.

Veil demonstrates how a stablecoin can offer transactional privacy (hidden balances, recipients, and amounts) while preserving regulatory compliance through an auditor role and a threshold-gated proof-of-innocence mechanism. The compliance design follows the association set construction from Buterin et al. (2023) and adapts the encrypted-viewing-key pattern from StarkWare's STRK20 framework.

This project was built as part of the Web3Bridge Zero-Knowledge Cohort.

## What Veil does

Veil is a private token contract on Aztec where:

- The token issuer mints private VEIL directly to registered users.
- Users hold private balances visible only to themselves.
- Users transfer VEIL privately to other registered users.
- Users withdraw VEIL to public addresses, exposing only the destination and amount, never the sender or their history.
- A designated auditor can request access to a specific user's history under a public, on-chain process.
- Users can rotate their audit key to limit forward visibility after an audit.
- Transfers above a configurable threshold require a Merkle inclusion proof showing the sender's deposit is in the auditor's approved list.

The contract verifies the proof of innocence inside a real ZK circuit using Poseidon2. The off-chain Merkle tree is built and queried using a TypeScript library that uses the same Poseidon2 implementation, ensuring the off-chain hashes match the on-chain verifier exactly.

## Architecture

| Component | Language | Location | Role |
| --- | --- | --- | --- |
| Veil contract | Noir, Aztec.nr | `src/` | Private balances, audit registry, approved-list root, threshold logic, Merkle proof verifier |
| Off-chain Merkle library | TypeScript | `lib/merkle/` | Builds the approved-list tree, generates inclusion proofs, computes the root the auditor publishes |
| Integration tests | TypeScript, Aztec.js | `tests/` | End-to-end tests, narrated CLI demo, privacy verification script |
| Frontend | TypeScript, React, Vite | `app/` | Browser-based UI with three persona panels and a chain inspector |

## Compliance design

Three layered mechanisms work together:

**Audit registry.** Each user, on first interaction, registers a viewing key encrypted to the auditor's public key. The contract stores the encrypted blob without ever decrypting it. Only the auditor can decrypt, and only off-chain.

**Public audit requests.** When the auditor wants to investigate a user, they call `request_audit`. This emits a public event with the target user, a reason hash, and the block number. The user (and anyone watching) sees the request. The auditor can then read the encrypted blob from storage and decrypt it off-chain.

**Threshold-gated proof of innocence.** Transfers below the threshold pass through with no compliance check. Transfers above the threshold require the user to submit a Merkle inclusion proof showing one of their deposits is in an approved set the auditor maintains. The contract verifies the proof inside a ZK circuit using Poseidon2.

## Privacy guarantees

What Veil hides from public observers:

- User balances
- Transfer recipients
- Transfer amounts
- The graph of who transfers to whom

What Veil exposes (deliberately, for compliance):

- Mint events with deposit IDs and recipient addresses
- The current approved-list Merkle root
- Audit requests (which user is being investigated, when)
- Withdrawal amounts and destinations

This is a "privacy with compliance" trade-off, modelled on 0xbow Privacy Pools and the 2023 Buterin paper. The system protects everyday user privacy while providing the auditability that regulated jurisdictions require.

## Getting started

### Prerequisites

- Node.js 22 or higher
- Docker
- The Aztec CLI (`aztec start --local-network` should work)

### Compile the contract and generate TypeScript bindings

The `target/` directory (compiler output) and `artifacts/` directory (TypeScript bindings) are intentionally not committed; regenerate them locally:

```bash
aztec compile
aztec codegen target -o artifacts
```

### Run the local network

In one terminal, start the Aztec local network (formerly called the Sandbox):

```bash
aztec start --local-network
```

Leave this running. It serves the node at `http://localhost:8080` and provides three pre-funded test accounts.

### Run the integration test

In another terminal:

```bash
cd tests
npm install
npm test
```

This deploys the contract end-to-end, registers users, mints tokens, publishes a Merkle root, generates an inclusion proof off-chain, and verifies the proof passes inside the contract. All eight checks must pass.

### Run the narrated CLI demo

```bash
cd tests
npm run demo
```

Produces a step-by-step walkthrough with plain-English narration suitable for a screen recording.

### Run the privacy verification

```bash
cd tests
npm run check-privacy
```

Performs a private transfer, then queries the chain for the transaction's `noteHashes`, `nullifiers`, and `publicDataWrites`. Demonstrates that the sender, recipient, and amount appear nowhere in the public data — only opaque commitments.

### Run the React frontend

```bash
cd app
npm install
npm run dev
```

Opens the UI at `http://localhost:5173`. Includes a "Chain inspector" panel that fetches each transfer's on-chain effects and verifies, in real time, that none of the public data leaks the sender, recipient, or amount.

### Run the off-chain Merkle library standalone

```bash
cd lib/merkle
npm install
npx tsx src/test.ts
```

## Authors

- Akpolo Ogagaoghene Prince
- Ali Anuoluwapo

## Tutor

Musa Abdulkareem (Web3Bridge Zero-Knowledge Cohort)

## Acknowledgements

This project builds on the Aztec Network's Noir framework and the standard Aztec.nr token tutorial. The compliance design is adapted from Buterin, Illum, Nadler, Schär and Soleimani (2023), and the encrypted-viewing-key pattern is inspired by StarkWare's STRK20 framework.

## License

MIT
