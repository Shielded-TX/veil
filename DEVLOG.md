# Veil — Developer Reference

## What the sandbox logs mean

When you run `aztec start --local-network`, the terminal shows Aztec's internal
machinery. Here is every term you will encounter:

---

### The basic timeline of a transaction

```
Your browser               Aztec node (local)             Ethereum L1 (local Anvil)
──────────────             ──────────────────             ─────────────────────────
call register_for_audit()
  │
  ▼
Private execution (local)
  - ZK proof generated in browser
  - Note commitments encrypted
  - Nullifiers computed
  │
  ▼
TX submitted to node ─────▶  Added to mempool
                              │
                              ▼
                            Block assembled (slot)
                            Public functions executed
                            State tree updated
                              │
                              ▼
                            Proof verified
                              │
                              ▼
                            Batch committed ────────────▶ L1 blob transaction
                            to Ethereum                   (EIP-4844)
```

---

### Log terms glossary

| Term | Meaning |
|------|---------|
| `nonce: 226` | Ethereum tx counter for the sequencer's account. Every L1 tx from the same address increments this. Lets you match a specific L1 tx on Etherscan |
| `account: 0xf39fd6…` | The default Hardhat/Anvil test account — this is the local sequencer. On a public network this would be an actual validator |
| `slot` | Aztec's time unit, ~36 seconds. One slot = one opportunity to produce a block. Slots are numbered sequentially from genesis |
| `epoch` | A group of slots (~32). After each epoch the sequencer submits a validity proof to L1 and finalises a batch of blocks |
| `provenCheckpointNumber: 23` | The highest Aztec block for which a ZK validity proof has been verified on L1. Blocks below this are cryptographically final |
| `archiveRoot` | The Merkle root of all block hashes so far — Aztec's equivalent of Ethereum's state root. Every L2 block updates this |
| `lastArchive` | The archiveRoot of the previous block, chaining blocks together |
| `blockHeadersHash` | Hash of all block headers in this batch |
| `blobsHash` | EIP-4844 blob hash. Aztec publishes transaction data as Ethereum blobs (cheap DA), not calldata |
| `inHash` | Hash of all L1→L2 messages (deposits) included in this block |
| `epochOutHash` | Hash of all L2→L1 messages (withdrawals) settled this epoch |
| `totalManaUsed: 728190` | Aztec's gas equivalent. Mana = computation on the public VM |
| `gasFees: {feePerDaGas, feePerL2Gas}` | Data availability cost (blob space) and compute cost per unit of mana |
| `coinbase: 0xf39fd6…` | The local sequencer address that collects block fees |
| `feeRecipient: 0x000…` | The Aztec address receiving L2 fees. All zeros in devnet (fees not collected) |
| `privateLogCount: 2` | **The privacy proof.** This is the number of encrypted note commitments written in this block. These are the only on-chain artefacts of a private transfer — indistinguishable from random numbers |
| `publicLogCount: 0` | Zero public event logs. Confirms no sender, recipient, or amount was ever written to public state |
| `isBlobTx: true` | The L1 commitment uses EIP-4844 blob transactions — cheap off-chain DA instead of expensive calldata |
| `blobGasUsed: 131072` | One full blob (128 KB) consumed. Blobs are deleted from L1 after ~18 days; the ZK proof and archive root are permanent |
| `Slot was missed` | No block produced in this slot — normal in a single-validator devnet when the node is busy |
| `Slot was filled` | A block was produced and committed in this slot |
| `Warped L1 timestamp` | The devnet fast-forwards simulated time so you don't wait 12 s per Ethereum block. This is test-only behaviour |
| `No committee found for epoch` | Expected warning. The devnet has no validator committee — one node does everything and skips the committee check |
| `World state updated` | Aztec's internal state trees (note hash tree, nullifier tree, archive tree) updated with the new block |
| `Proven tip moved: 23 → 24` | The highest proven block advanced. Your transaction is now cryptographically final on L1 |

---

### The two lines that prove privacy

After any private transfer, find these in the logs:

```
"privateLogCount":2,"publicLogCount":0
```

- `privateLogCount: 2` — two encrypted note commitments written (one for the
  recipient, one change note for the sender). These look like random 32-byte
  numbers to any observer.
- `publicLogCount: 0` — zero public logs. No address, no amount, no metadata
  ever written to readable public state.

This is the same claim the Privacy Inspector makes in the UI, backed by raw node output.

---

## Demo flow (end to end)

### Prerequisites

```bash
aztec start --local-network   # starts devnet on http://localhost:8080
cd app && npm run dev          # starts frontend on http://localhost:5173
```

### Step-by-step

| # | Action | Who | Where |
|---|--------|-----|-------|
| 1 | Connect and deploy | — | `/connect` → choose Alice → click Connect |
| 2 | Register Alice | Alice | `/register` → Register Alice |
| 3 | Mint 5 000 VEIL to Alice | Owner | Switch to Owner/Auditor → `/auditor` → Mint → Alice |
| 4 | Register Bob | Bob | Switch to Bob → `/register` → Register Bob |
| 5 | Send 500 VEIL | Alice | Switch to Alice → `/send` → amount 500 → Send → Bob |
| 6 | Inspect the transaction | — | `/inspect` — see what an observer sees vs what you see |
| 7 | Expand "Ethereum comparison" | — | `/inspect` — click the collapsible card |
| 8 | Approve a deposit ID | Owner | `/auditor` → Approve deposit ID `1` → Publish root |
| 9 | Send 2 000 VEIL (above threshold) | Alice | `/send` → 2000 → deposit ID 1 → proof generates |
| 10 | Inspect the above-threshold tx | — | `/inspect` — same verdict: fully shielded |

### What to point out during a presentation

1. **Step 5 logs**: find `privateLogCount: 2, publicLogCount: 0` in the terminal
2. **Step 6 inspector**: left column shows only noise; right column shows the real transfer
3. **Step 7 Ethereum card**: show `🔴 visible` on every field — contrast with left column
4. **Step 9 proof**: the purple `<ProofStatus>` component shows proof generation happening in the browser
5. **Run the CLI script**: `cd tests && yarn check-privacy` — programmatic proof, no UI involved

---

## Sending real USDC on testnet

To demonstrate with real funds instead of the local devnet:

### Which chain

Aztec's public testnet sits on top of **Ethereum Sepolia**. You need:

- Sepolia ETH (for L1 gas) — free from [sepoliafaucet.com](https://sepoliafaucet.com)
- Sepolia USDC — from [Circle's testnet faucet](https://faucet.circle.com) or deploy
  a mock ERC-20
- An Aztec testnet RPC endpoint (Aztec provides one at `https://api.aztec.network/testnet/...`)

### Bridge architecture

```
Ethereum Sepolia                          Aztec testnet (L2)
────────────────                          ──────────────────
USDC ERC-20 contract                      Veil contract
      │                                         ▲
      ▼                                         │
Portal contract  ──── L1→L2 message ──────────▶ claim() mints
(approve + depositToAztec)                      private VEIL
```

1. User approves the portal contract to spend their USDC
2. User calls `portal.depositToAztec(amount, aztecRecipient)`
3. Aztec's archiver picks up the L1→L2 message
4. User calls `claim()` on the Veil contract on L2 — VEIL appears in their private balance
5. The USDC is locked in the portal until they withdraw

### What to deploy

```
contracts/
  USDCPortal.sol      ← L1 contract that holds USDC and relays messages
  VeilPortalBridge.nr ← L2 message receiver (claim function in Veil contract)
```

This is the `/deposit` page in the app — currently scaffolded. The bridge call
needs `viem` for L1 interactions and the Aztec portal address on Sepolia.

### Estimated effort

| Task | Time |
|------|------|
| Write USDCPortal.sol | 1–2 h |
| Add `claim()` to Veil contract | 1 h |
| Wire up `/deposit` page | 2–3 h |
| Deploy to Aztec testnet | 1 h |

---

## Deploying to Aztec testnet

### 1. Get testnet access

```bash
# Point the CLI at the public testnet instead of local
export AZTEC_NODE_URL=https://api.aztec.network/testnet/v1   # check current URL
                                                              # at docs.aztec.network
```

### 2. Fund your deployer account

The deployer needs testnet ETH on Sepolia and testnet Aztec gas. Both are
available from the Aztec Discord faucet channel.

### 3. Deploy the contract

```bash
# From repo root
aztec deploy \
  --contract-artifact target/bob_token_contract-Veil.json \
  --node-url $AZTEC_NODE_URL \
  --salt 0 \
  -- \
  <owner_address> \
  <auditor_address> \
  0 \
  1000
```

The deploy prints a contract address. Save it.

### 4. Update the frontend

In `app/src/hooks/useVeil.ts`:

```typescript
// Replace this:
const NODE_URL = 'http://localhost:8080';

// With:
const NODE_URL = 'https://api.aztec.network/testnet/v1';
```

And instead of deploying in `connect()`, call `VeilContract.at(address, wallet)`
with the pre-deployed address.

### 5. What changes on-chain vs locally

| | Local devnet | Aztec testnet |
|--|--|--|
| Chain | Hardhat (in-process) | Ethereum Sepolia |
| Block explorer | None | Aztec's own testnet explorer |
| L1 transactions | Visible in local Anvil | Visible on **Sepolia Etherscan** |
| Proof time | Same (browser prover) | Same |
| Note commitments | Local only | Written to Sepolia (via blobs) |
| Withdrawal events | Local only | Visible on Sepolia Etherscan |

The key point for the presentation: the **L1 batch transaction on Sepolia Etherscan**
is visible — you can look it up by the tx hash from the `Sent L1 transaction 0xc706…`
log line. It shows a blob transaction from the sequencer to the rollup contract.
Clicking "Blob data" shows encrypted noise. There is no record of individual transfers.

---

## Frontend architecture

```
app/src/
├── styles/tokens.css          Design tokens — single source of truth
├── context/VeilContext.tsx    Global state — wraps useVeil() for all routes
├── hooks/useVeil.ts           All aztec.js logic (connect, register, mint,
│                              transfer, approveDeposit, requestAudit, inspect)
├── lib/format.ts              formatHash(), formatAmount(), formatHexOrDec()
├── components/
│   ├── Shell/                 Sidebar + topbar + persona switcher + activity strip
│   ├── Card/                  Bordered surface with optional tone stripe
│   ├── HashBadge/             Truncated hash, click-to-copy
│   ├── AmountInput/           Numeric input with max button + threshold hint
│   ├── ProofStatus/           Animated ZK proof progress (purple, 3-step)
│   └── EmptyState/            Empty list placeholder
└── pages/
    ├── Connect.tsx            Persona picker + devnet connection
    ├── Dashboard.tsx          Balance hero + recent txs + CTAs
    ├── Register.tsx           Audit key registration + rotation
    ├── Send.tsx               Private transfer + ProofStatus
    ├── Withdraw.tsx           Private → public withdrawal (scaffold)
    ├── Inspect.tsx            Privacy Inspector — hero feature
    ├── Auditor.tsx            Gated portal (mint, approve, audit)
    └── Deposit.tsx            L1→L2 bridge (scaffold)
```

### Design tokens (src/styles/tokens.css)

| Token | Value | Use |
|-------|-------|-----|
| `--accent` | `#00D9A0` | Primary action, shielded state |
| `--zk` | `#8B7FFF` | ZK proof generation UI |
| `--audit` | `#E8A830` | Auditor / disclosure states |
| `--exposed` | `#FF5757` | Leaked data in the Inspector |
| `--shielded` | `var(--accent)` | Privacy-verified state |
| `--c-alice` | `#818CF8` | Alice persona stripe |
| `--c-bob` | `#34D399` | Bob persona stripe |
| `--c-owner` | `#E8A830` | Owner/Auditor persona stripe |
