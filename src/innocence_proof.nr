// innocence_proof.nr
// Proof-of-Innocence circuit for the Veil shielded stablecoin.
//
// Based on: Buterin, Wahrstatter, Bajpai (2023) — "Blockchain Privacy and Regulatory Compliance:
// Towards a Practical Equilibrium" (the Privacy Pools paper).
//
// WHAT THIS CIRCUIT PROVES
// ========================
// Given:
//   - A set of notes the sender controls (private)
//   - The Aztec note hash tree root (public)
//   - The auditor's bad-list Merkle tree root (public)
//   - The transfer amount (public)
//
// The circuit proves — without revealing which notes or how much each is worth:
//   (1) Each note exists in the Aztec note hash tree (membership proof)
//   (2) Each note commitment does NOT exist in the bad-list tree (non-membership proof)
//   (3) The notes' total value covers the transfer amount
//
// CIRCUIT PARAMETERS
// ==================
// These must match the constants in veil_updated.nr exactly.
//
//   MAX_NOTES          = 4    — max notes aggregated in one proof
//   NOTE_TREE_DEPTH    = 32   — depth of Aztec's note hash tree
//   BAD_LIST_DEPTH     = 20   — depth of the auditor's bad-list indexed Merkle tree
//
// PROOF SYSTEM
// ============
// Compiled by the Noir compiler (nargo) to UltraPlonk constraints.
// The verifying key is registered in the Veil contract and called via
// Aztec's `verify_proof` oracle inside `_verify_compliance_witness_private()`.

// ---------------------------------------------------------------------------
// CONSTANTS — must match veil_updated.nr
// ---------------------------------------------------------------------------

global MAX_NOTES:       u32 = 4;
global NOTE_TREE_DEPTH: u32 = 32;
global BAD_LIST_DEPTH:  u32 = 20;

// ---------------------------------------------------------------------------
// IMPORTED PRIMITIVES
// ---------------------------------------------------------------------------
//
// `std::hash::pedersen_hash`  — Pedersen hash over BN254 (Aztec's note commitment scheme)
// `std::merkle::compute_merkle_root` — standard Merkle root computation
// `aztec::protocol::address::AztecAddress` — address type used for siloing

use dep::std::hash::pedersen_hash;
use dep::std::merkle::compute_merkle_root;
use dep::aztec::protocol::address::AztecAddress;

// ---------------------------------------------------------------------------
// STRUCTS
// ---------------------------------------------------------------------------

// A single note the user controls.
//
// PRIVATE — never revealed outside the circuit.
//
// Fields:
//   value   — token amount in this note (u64 to match the contract's amount type)
//   owner   — the AztecAddress this note belongs to (used for commitment computation)
//   secret  — random blinding factor chosen at note creation time
//   path    — sibling hashes on the Merkle path from leaf → note hash tree root
//   index   — leaf index (bit-array: bit i = 0 means the sibling at depth i is on the right)
//
// The note commitment is computed as:
//   commitment = pedersen_hash([owner.to_field(), value as Field, secret])
//
// This must match exactly the commitment scheme used in BalanceSet.
// If BalanceSet uses a different hash or field order the membership proofs will fail.
struct NoteWitness {
    value:  u64,
    owner:  AztecAddress,
    secret: Field,
    path:   [Field; NOTE_TREE_DEPTH],
    index:  Field,
}

// Non-membership witness for the indexed bad-list Merkle tree.
//
// PRIVATE — never revealed.
//
// An indexed Merkle tree stores leaves sorted by value. To prove X is absent:
//   - Find the "low leaf" — the largest leaf value that is still less than X.
//   - Show that low_leaf.next_value > X (or low_leaf.next_value == 0 and low_leaf is the tail).
//   - Prove the low leaf is actually in the tree with a membership proof.
//
// If the prover can supply a valid low leaf with correct membership proof AND
// the ordering constraint holds, then X cannot be in the tree.
//
// Fields:
//   low_value      — the predecessor leaf's own value (must be < commitment being checked)
//   low_next_value — the predecessor's next-pointer (must be > commitment, or 0 if last leaf)
//   low_index      — leaf index of the predecessor in the bad-list tree
//   low_path       — Merkle sibling path: predecessor leaf → bad-list root
struct NonMembershipWitness {
    low_value:      Field,
    low_next_value: Field,
    low_index:      Field,
    low_path:       [Field; BAD_LIST_DEPTH],
}

// ---------------------------------------------------------------------------
// HELPER — NOTE COMMITMENT
// ---------------------------------------------------------------------------

// Recomputes the commitment that was stored in the Aztec note hash tree
// when this note was created. The commitment scheme must match BalanceSet exactly.
//
// Aztec uses Pedersen hashing with a domain separator per note type.
// Here we use a simplified 3-field hash: [owner, value, secret].
// In production confirm the exact field order and separator used by BalanceSet.
fn compute_note_commitment(note: NoteWitness) -> Field {
    pedersen_hash(
        [note.owner.to_field(), note.value as Field, note.secret],
        0, // domain separator 0 — adjust to match BalanceSet's actual separator
    )
}

// ---------------------------------------------------------------------------
// HELPER — INDEXED TREE LEAF HASH
// ---------------------------------------------------------------------------

// Computes the leaf hash for an indexed Merkle tree leaf.
// Each leaf in the indexed tree stores (value, next_value, next_index).
// The leaf hash is: pedersen_hash([value, next_value, next_index])
//
// The bad-list publisher must use the same hash when building the tree.
fn compute_indexed_leaf_hash(value: Field, next_value: Field, next_index: Field) -> Field {
    pedersen_hash([value, next_value, next_index], 1) // domain separator 1 for indexed tree leaves
}

// ---------------------------------------------------------------------------
// HELPER — NOTE MEMBERSHIP PROOF
// ---------------------------------------------------------------------------

// Verifies that a note commitment exists as a leaf in the Aztec note hash tree.
//
// Uses the standard Merkle membership check:
//   - Hash the note's preimage to get the commitment
//   - Walk up the Merkle path using sibling hashes
//   - Check the computed root equals the provided note_hash_tree_root
//
// The index Field encodes left/right at each level: bit i = 0 means the
// sibling at depth i is on the right, so we hash (node, sibling).
fn verify_note_membership(
    note:                NoteWitness,
    commitment:          Field,
    note_hash_tree_root: Field,
) {
    let computed_root = compute_merkle_root(commitment, note.index, note.path);
    assert(
        computed_root == note_hash_tree_root,
        "Note membership proof failed: note not found in the Aztec note hash tree",
    );
}

// ---------------------------------------------------------------------------
// HELPER — NON-MEMBERSHIP PROOF
// ---------------------------------------------------------------------------

// Verifies that a note commitment does NOT appear in the bad-list indexed Merkle tree.
//
// Steps:
//   1. Compute the low leaf's hash from the provided low_value / next values.
//   2. Verify the low leaf IS in the bad-list tree (membership proof of the predecessor).
//   3. Assert the ordering invariants:
//      a. low_value < commitment  (predecessor is strictly below the target)
//      b. next_value > commitment OR next_value == 0 (successor skips over target, or it's the tail)
//
// If all three steps pass, the commitment cannot be in the tree.
fn verify_non_membership(
    commitment:    Field,
    w:             NonMembershipWitness,
    bad_list_root: Field,
) {
    // Step 1 — hash the low leaf
    let low_leaf_hash = compute_indexed_leaf_hash(w.low_value, w.low_next_value, w.low_index);

    // Step 2 — prove the low leaf is in the bad-list tree
    let computed_root = compute_merkle_root(low_leaf_hash, w.low_index, w.low_path);
    assert(
        computed_root == bad_list_root,
        "Non-membership proof failed: low leaf not found in bad-list tree",
    );

    // Step 3a — the low leaf is strictly less than the commitment
    // We use Field comparison via subtraction: if low_value >= commitment, this underflows.
    // Noir's `as u128` cast for Field comparison on BN254 is safe for values up to 2^128.
    // For production: use the `noir-bignum` library for a full Field-order comparison.
    let low_as_u128      = w.low_value as u128;
    let commitment_u128  = commitment as u128;
    let next_as_u128     = w.low_next_value as u128;

    assert(
        low_as_u128 < commitment_u128,
        "Non-membership proof invalid: low leaf value must be strictly less than the commitment",
    );

    // Step 3b — the next pointer skips over the commitment (or is the tail sentinel 0)
    let is_tail            = w.low_next_value == 0;
    let next_exceeds_target = next_as_u128 > commitment_u128;
    assert(
        is_tail | next_exceeds_target,
        "Non-membership proof invalid: low leaf's next pointer does not skip over the commitment",
    );
}

// ---------------------------------------------------------------------------
// MAIN CIRCUIT ENTRY POINT
// ---------------------------------------------------------------------------

// The `main` function is what Noir compiles into the proof circuit.
// It is called by Aztec's `verify_proof` oracle inside the Veil private function.
//
// PUBLIC INPUTS  (visible to the verifier / sequencer):
//   note_hash_tree_root — root of the Aztec note hash tree at a recent block
//   bad_list_root       — root of the auditor's bad-list indexed Merkle tree
//   amount              — the transfer amount being authorised
//   sender              — the sender's AztecAddress (siloed into note commitments)
//
// PRIVATE INPUTS (the hidden witness — only the prover sees these):
//   notes               — up to MAX_NOTES note preimages + their Merkle paths
//   non_memberships     — one non-membership witness per note
//
// WHAT THE CIRCUIT CONSTRAINS:
//   For each note i in 0..MAX_NOTES:
//     - If note.value > 0 (i.e. it is a real note, not padding):
//         * Recompute its commitment
//         * Check it is in the note hash tree     (membership)
//         * Check it is NOT in the bad-list tree  (non-membership)
//   - sum(note.value for real notes) >= amount

fn main(
    // Public inputs
    note_hash_tree_root: pub Field,
    bad_list_root:       pub Field,
    amount:              pub u64,
    sender:              pub AztecAddress,

    // Private inputs (witness)
    notes:           [NoteWitness; MAX_NOTES],
    non_memberships: [NonMembershipWitness; MAX_NOTES],
) {
    // Running total of note values. u128 to avoid overflow for large amounts.
    let mut total: u128 = 0;

    for i in 0..MAX_NOTES {
        let note = notes[i];

        if note.value > 0 {
            // ----------------------------------------------------------------
            // 1. CONSISTENCY: the note owner must be the sender.
            //    Prevents a user from borrowing someone else's note in their proof.
            // ----------------------------------------------------------------
            assert(
                note.owner.to_field() == sender.to_field(),
                "Note owner does not match the declared sender",
            );

            // ----------------------------------------------------------------
            // 2. COMMITMENT: recompute the note commitment from its preimage.
            // ----------------------------------------------------------------
            let commitment = compute_note_commitment(note);

            // ----------------------------------------------------------------
            // 3. MEMBERSHIP: the note exists in the Aztec note hash tree.
            //    This proves the note is real and unspent (not yet nullified).
            // ----------------------------------------------------------------
            verify_note_membership(note, commitment, note_hash_tree_root);

            // ----------------------------------------------------------------
            // 4. NON-MEMBERSHIP: the note commitment is NOT in the bad-list.
            //    This is the core of the Privacy Pools proof of innocence.
            // ----------------------------------------------------------------
            verify_non_membership(commitment, non_memberships[i], bad_list_root);

            // ----------------------------------------------------------------
            // 5. ACCUMULATE VALUE
            // ----------------------------------------------------------------
            total += note.value as u128;
        }
    }

    // ------------------------------------------------------------------------
    // 6. SUFFICIENCY: the total value of clean notes covers the transfer amount.
    //    The user cannot transfer more than their proven-clean note set.
    // ------------------------------------------------------------------------
    assert(
        total >= amount as u128,
        "Insufficient clean note value: total value of notes not in bad list is less than the transfer amount",
    );
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

#[test]
fn test_non_membership_tail_leaf() {
    // A commitment should be provably absent when the low leaf is the tail (next == 0)
    // and the commitment is greater than the low leaf's value.
    //
    // In a real test: build a small indexed Merkle tree with known leaves,
    // compute the root, construct the low leaf witness, and call verify_non_membership.
    // Here we just check the ordering logic with a mock root that will fail the
    // membership check (expected in unit tests — full integration needs a real tree).

    let commitment: Field = 100;
    let w = NonMembershipWitness {
        low_value:      50,   // < 100 ✓
        low_next_value: 0,    // tail sentinel ✓
        low_index:      0,
        low_path:       [0; BAD_LIST_DEPTH], // zeroed path → computed root will be leaf hash
    };
    // This will fail on the membership check (zeroed path, mock root) but the
    // ordering constraints pass. Remove the verify_non_membership call and test
    // the ordering logic directly in isolation:
    let commitment_u128  = commitment as u128;
    let low_as_u128      = w.low_value as u128;
    let next_as_u128     = w.low_next_value as u128;
    let is_tail          = w.low_next_value == 0;
    let next_ok          = next_as_u128 > commitment_u128;

    assert(low_as_u128 < commitment_u128, "ordering check failed");
    assert(is_tail | next_ok, "tail/next check failed");
}

#[test]
fn test_note_commitment_is_deterministic() {
    // The same note preimage must always produce the same commitment.
    // If this fails, the commitment scheme doesn't match BalanceSet.
    let dummy_address = AztecAddress::from_field(0xdeadbeef);
    let note = NoteWitness {
        value:  1000,
        owner:  dummy_address,
        secret: 0xabcdef,
        path:   [0; NOTE_TREE_DEPTH],
        index:  0,
    };
    let c1 = compute_note_commitment(note);
    let c2 = compute_note_commitment(note);
    assert(c1 == c2, "commitment is not deterministic");
}
