// Veil: privacy-first shielded stablecoin on Aztec Network
// Updated to accept a real proof-of-innocence from the InnocenceProof circuit.
//
// Key architectural change from the prototype:
//   BEFORE: `innocence_proof: Field` was passed into a public function and
//           checked with `proof != 0` — anyone could pass any non-zero value.
//
//   NOW:    The non-membership check happens INSIDE the private circuit (on the
//           user's machine). The private function verifies the Noir proof locally.
//           A separate enqueued public call then confirms that the bad_list_root
//           the user proved against matches what is actually stored on chain.
//           This means the sequencer can never accept a proof made against a
//           stale or fabricated bad-list root.
//
// Proof-of-innocence circuit: see innocence_proof.nr

use aztec::macros::aztec;

#[aztec]
pub contract Veil {
    use aztec::{
        macros::{
            events::event,
            functions::{external, initializer, only_self},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Map, Owned, PublicMutable, SharedImmutable},
    };
    use balance_set::BalanceSet;

    // =========================================================================
    // TYPES
    // =========================================================================

    // A single note witness: the raw note data the user holds locally,
    // plus its Merkle path in the Aztec note hash tree (depth 32).
    // Passed as a private input to private functions that need it.
    //
    // FIELD LAYOUT (must match InnocenceProof circuit's NoteWitness struct):
    //   value   — the token amount stored in this note
    //   secret  — the random blinding factor that was used when the note was created
    //   path    — the sibling hashes on the path from leaf → note hash tree root
    //   index   — the leaf index in the note hash tree (determines left/right at each level)
    struct NoteWitness {
        value:  u64,
        secret: Field,
        path:   [Field; NOTE_TREE_DEPTH],
        index:  Field,
    }

    // A single indexed-tree non-membership witness.
    // Used to prove that a note commitment does NOT appear in the bad-list tree.
    // An indexed Merkle tree stores leaves sorted by value; to prove X is absent
    // you show the predecessor leaf (low_leaf) whose next pointer skips over X.
    //
    // FIELD LAYOUT (must match InnocenceProof circuit's NonMembershipWitness struct):
    //   low_leaf_value      — the predecessor leaf's value (low_leaf.value < X)
    //   low_leaf_next_value — the successor pointer (X < low_leaf.next_value, or 0 if tail)
    //   low_leaf_index      — position of the predecessor leaf in the tree
    //   low_leaf_path       — sibling hashes: predecessor leaf → bad-list root
    struct NonMembershipWitness {
        low_leaf_value:      Field,
        low_leaf_next_value: Field,
        low_leaf_index:      Field,
        low_leaf_path:       [Field; BAD_LIST_TREE_DEPTH],
    }

    // Everything the private_transfer / withdraw_to_public functions need
    // in order to prove compliance above the threshold.
    // Passed in by the user's wallet; verified fully inside the private circuit.
    struct ComplianceWitness {
        // One NoteWitness per note being spent (up to MAX_COMPLIANCE_NOTES).
        // If fewer than MAX_COMPLIANCE_NOTES notes are needed, pad with zero-value entries.
        notes:           [NoteWitness; MAX_COMPLIANCE_NOTES],
        // One non-membership witness per note (proving each note is NOT on the bad list).
        non_memberships: [NonMembershipWitness; MAX_COMPLIANCE_NOTES],
        // The bad-list root the user is proving against.
        // The public call _verify_compliance_root() will confirm this matches chain state.
        claimed_root:    Field,
    }

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    // Encrypted viewing key size, in field elements.
    global ENCRYPTED_KEY_SIZE: u32 = 4;

    // Depth of the Aztec note hash tree (2^32 leaves).
    global NOTE_TREE_DEPTH: u32 = 32;

    // Depth of the bad-list indexed Merkle tree published by the auditor.
    // 2^20 = 1,048,576 slots — more than enough for a compliance exclusion list.
    global BAD_LIST_TREE_DEPTH: u32 = 20;

    // Maximum number of notes a user may aggregate in a single compliance proof.
    // If the user's balance is split across more notes than this they must consolidate first.
    global MAX_COMPLIANCE_NOTES: u32 = 4;

    // =========================================================================
    // STORAGE
    // =========================================================================

    #[storage]
    struct Storage<Context> {
        // Address allowed to mint new VEIL tokens.
        owner:              PublicMutable<AztecAddress, Context>,

        // Address allowed to request audits and update compliance state.
        auditor:            PublicMutable<AztecAddress, Context>,

        // Private per-user balances. Each user's balance is a set of encrypted notes;
        // only the owner can read them. The chain stores only note commitments.
        private_balances:   Owned<BalanceSet<Context>, Context>,

        // Audit registry: encrypted viewing keys, one per user, stored publicly.
        // Encrypted off-chain by the user's wallet to the auditor's public key.
        // Anyone can read the ciphertext; only the auditor can decrypt it.
        audit_keys:         Map<AztecAddress, PublicMutable<[Field; ENCRYPTED_KEY_SIZE], Context>, Context>,

        // The current bad-list Merkle root, set by the auditor.
        // This is the tree that compliance proofs are checked against.
        bad_list_root:      PublicMutable<Field, Context>,

        // The transfer amount (in token units) above which a compliance proof is required.
        transfer_threshold: PublicMutable<u64, Context>,
    }

    // =========================================================================
    // EVENTS
    // =========================================================================

    // Emitted when the auditor triggers an audit on a user.
    // Public — anyone monitoring the chain can see it. Users should react by rotating their key.
    #[event]
    struct AuditRequested {
        target_user:  AztecAddress,
        reason_hash:  Field,
        block_number: u64,
    }

    // Emitted when a user exits private VEIL to a public address.
    // Amount and recipient are public; sender stays private.
    #[event]
    struct Withdrawal {
        recipient:    AztecAddress,
        amount:       u64,
        block_number: u64,
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    #[external("public")]
    #[initializer]
    fn constructor(
        initial_owner:              AztecAddress,
        initial_auditor:            AztecAddress,
        initial_bad_list_root:      Field,
        initial_transfer_threshold: u64,
    ) {
        self.storage.owner.write(initial_owner);
        self.storage.auditor.write(initial_auditor);
        self.storage.bad_list_root.write(initial_bad_list_root);
        self.storage.transfer_threshold.write(initial_transfer_threshold);
    }

    // =========================================================================
    // INTERNAL — PRIVATE HELPERS
    // These run inside the user's PXE, not on the sequencer.
    // =========================================================================

    // Verifies the ComplianceWitness fully inside the private circuit.
    //
    // Steps performed in-circuit:
    //   1. For each note[i]:
    //      a. Recompute note_commitment = pedersen_hash(owner, value, secret)
    //      b. Verify note_commitment is a leaf in the note hash tree
    //         (Merkle membership proof using notes[i].path and notes[i].index)
    //      c. Verify note_commitment is NOT a leaf in the bad-list tree
    //         (Indexed Merkle non-membership proof using non_memberships[i])
    //   2. Verify that sum(notes[i].value) >= amount
    //   3. Return the claimed_root so the caller can pass it to a public check.
    //
    // NOTE: This calls the InnocenceProof Noir circuit, compiled separately.
    // The circuit enforces all constraints; this is just the call-site glue.
    //
    // PROTOTYPE STATUS: The call to `innocence_proof::verify(...)` below is the
    // integration point. The circuit itself lives in innocence_proof.nr.
    // When the circuit is compiled it produces a verifier that can be embedded
    // in the Aztec.nr call here via the `verify_proof` oracle.
    fn _verify_compliance_witness_private(
        sender:   AztecAddress,
        amount:   u64,
        witness:  ComplianceWitness,
    ) -> Field {
        // Call the compiled InnocenceProof circuit via Aztec's proof verification oracle.
        // The circuit takes:
        //   Public inputs:  note_hash_tree_root (read from context), bad_list_root (witness.claimed_root), amount, sender
        //   Private inputs: witness.notes, witness.non_memberships
        //
        // The oracle returns true iff the proof verified. The constraint is automatic —
        // if verification fails the entire private execution aborts.
        //
        // Integration point: replace the assert below with the real oracle call once
        // the circuit is compiled and its verifying key is registered in the contract.
        let note_hash_tree_root = self.context.historical_header().state().partial().note_hash_tree().root();

        innocence_proof::verify(
            // Public inputs (visible to verifier)
            note_hash_tree_root,
            witness.claimed_root,
            amount,
            sender,
            // Private inputs (hidden witness)
            witness.notes,
            witness.non_memberships,
        );

        // Return the root so the caller can pass it to _verify_compliance_root()
        // for on-chain confirmation that it matches the stored bad_list_root.
        witness.claimed_root
    }

    // =========================================================================
    // INTERNAL — PUBLIC HELPERS (enqueued by private functions, run on sequencer)
    // =========================================================================

    // Checks the caller is the owner.
    #[external("public")]
    #[only_self]
    fn _assert_is_owner(address: AztecAddress) {
        assert_eq(address, self.storage.owner.read(), "Only the owner can mint VEIL tokens");
    }

    // Checks a user has registered for audit.
    #[external("public")]
    #[only_self]
    fn _assert_is_registered(user: AztecAddress) {
        let key = self.storage.audit_keys.at(user).read();
        let mut registered = false;
        for i in 0..ENCRYPTED_KEY_SIZE {
            if key[i] != 0 { registered = true; }
        }
        assert(registered, "User must register for audit before holding VEIL");
    }

    // Confirms that the bad-list root the private circuit proved against
    // matches the root currently stored on chain.
    //
    // WHY THIS MATTERS: The user's compliance proof is generated locally against
    // witness.claimed_root. Without this check a malicious user could:
    //   - generate a valid proof against an old root (before their address was added)
    //   - submit the tx using the stale root
    // This public call runs AFTER private execution on the sequencer and
    // verifies the claimed root equals what is currently published. If the auditor
    // has updated bad_list_root since the proof was generated, this call fails and
    // the tx is rejected. Users must re-prove against the current root.
    //
    // amount is passed in so the check can be skipped entirely for sub-threshold transfers
    // (matching the private-side skip — no compliance proof was produced at all).
    #[external("public")]
    #[only_self]
    fn _verify_compliance_root(amount: u64, claimed_root: Field) {
        let threshold = self.storage.transfer_threshold.read();
        if amount > threshold {
            let stored_root = self.storage.bad_list_root.read();
            assert(stored_root != 0, "Bad list root not initialised");
            assert_eq(
                claimed_root,
                stored_root,
                "Compliance proof was generated against a stale bad-list root — re-prove against the current root",
            );
        }
    }

    // Emits the withdrawal event from public context.
    #[external("public")]
    #[only_self]
    fn _emit_withdrawal(recipient: AztecAddress, amount: u64) {
        Withdrawal {
            recipient:    recipient,
            amount:       amount,
            block_number: self.context.block_number(),
        }.emit();
    }

    // =========================================================================
    // AUDIT REGISTRY
    // =========================================================================

    // User registers their encrypted viewing key.
    // The key is encrypted off-chain by the wallet using the auditor's public key.
    // Calling this again rotates the key (overwrites).
    #[external("public")]
    fn register_for_audit(encrypted_key: [Field; ENCRYPTED_KEY_SIZE]) {
        let user = self.msg_sender();
        self.storage.audit_keys.at(user).write(encrypted_key);
    }

    // Explicit alias for key rotation. Same implementation; distinct call-site semantics.
    #[external("public")]
    fn rotate_audit_key(new_encrypted_key: [Field; ENCRYPTED_KEY_SIZE]) {
        let user = self.msg_sender();
        self.storage.audit_keys.at(user).write(new_encrypted_key);
    }

    // Auditor requests access to a user's transaction history.
    // Emits a public event so the user and any observer can see the request.
    #[external("public")]
    fn request_audit(target_user: AztecAddress, reason_hash: Field) {
        assert_eq(
            self.msg_sender(),
            self.storage.auditor.read(),
            "Only the auditor can request audits",
        );

        let key = self.storage.audit_keys.at(target_user).read();
        let mut registered = false;
        for i in 0..ENCRYPTED_KEY_SIZE {
            if key[i] != 0 { registered = true; }
        }
        assert(registered, "Target user has not registered for audit");

        AuditRequested {
            target_user:  target_user,
            reason_hash:  reason_hash,
            block_number: self.context.block_number(),
        }.emit();
    }

    // =========================================================================
    // COMPLIANCE STATE UPDATES (auditor only)
    // =========================================================================

    #[external("public")]
    fn update_bad_list_root(new_root: Field) {
        assert_eq(self.msg_sender(), self.storage.auditor.read(), "Only the auditor can update the bad list");
        self.storage.bad_list_root.write(new_root);
    }

    #[external("public")]
    fn update_transfer_threshold(new_threshold: u64) {
        assert_eq(self.msg_sender(), self.storage.auditor.read(), "Only the auditor can update the threshold");
        self.storage.transfer_threshold.write(new_threshold);
    }

    // =========================================================================
    // CORE TOKEN OPERATIONS
    // =========================================================================

    // Mint new private VEIL tokens directly to a registered user.
    // Only the owner can call this. Minting is always below the threshold
    // (the owner is implicitly trusted for issuance).
    #[external("private")]
    fn mint(recipient: AztecAddress, amount: u64) {
        self.enqueue_self._assert_is_owner(self.msg_sender());
        self.enqueue_self._assert_is_registered(recipient);

        self.storage.private_balances.at(recipient)
            .add(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    // Transfer VEIL privately from sender to recipient.
    //
    // For amounts BELOW the threshold:
    //   - Pass `compliance: ComplianceWitness::empty()` (zeroed struct).
    //   - No proof is generated or verified.
    //
    // For amounts AT OR ABOVE the threshold:
    //   - The wallet must supply a full ComplianceWitness.
    //   - The private circuit verifies the non-membership proof in-circuit.
    //   - The enqueued public call confirms the root matches chain state.
    #[external("private")]
    fn private_transfer(
        recipient:  AztecAddress,
        amount:     u64,
        compliance: ComplianceWitness,
    ) {
        let sender = self.msg_sender();

        self.enqueue_self._assert_is_registered(sender);
        self.enqueue_self._assert_is_registered(recipient);

        // For above-threshold transfers: verify innocence fully in private context,
        // then pass the claimed root to the public check.
        let claimed_root = self._check_and_get_root_private(sender, amount, compliance);

        // Enqueue public root confirmation. For sub-threshold transfers,
        // claimed_root will be 0 and _verify_compliance_root() will skip the check.
        self.enqueue_self._verify_compliance_root(amount, claimed_root);

        // Debit sender, credit recipient.
        self.storage.private_balances.at(sender)
            .sub(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.storage.private_balances.at(recipient)
            .add(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    // Exit private VEIL to a public address.
    // Sender stays private. Amount and recipient become public via the Withdrawal event.
    #[external("private")]
    fn withdraw_to_public(
        amount:     u64,
        recipient:  AztecAddress,
        compliance: ComplianceWitness,
    ) {
        let sender = self.msg_sender();

        self.enqueue_self._assert_is_registered(sender);

        let claimed_root = self._check_and_get_root_private(sender, amount, compliance);
        self.enqueue_self._verify_compliance_root(amount, claimed_root);

        self.storage.private_balances.at(sender)
            .sub(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.enqueue_self._emit_withdrawal(recipient, amount);
    }

    // Private helper: if amount is above threshold, verify the compliance witness
    // in-circuit and return the claimed root. If below, return 0 (no proof needed).
    //
    // This runs in private context on the user's machine. The returned claimed_root
    // is passed to the public phase so the sequencer can confirm it matches storage.
    //
    // IMPORTANT: The threshold here must be read carefully. We cannot read public
    // storage directly inside a fully private function in all Aztec versions; the
    // threshold is loaded from a SharedImmutable or passed as a parameter by the
    // wallet. For simplicity we pass it as a parameter and validate it publicly.
    //
    // A future improvement: use SharedMutable so the threshold can be read in
    // private context without a separate public confirmation.
    fn _check_and_get_root_private(
        self,
        sender:     AztecAddress,
        amount:     u64,
        compliance: ComplianceWitness,
    ) -> Field {
        // Read the threshold from storage.
        // In a fully private context this read is unconstrained — the public call
        // _verify_compliance_root() acts as the constraint by checking root matches.
        // If you want the threshold itself to be privately verified, store it in
        // a SharedImmutable and use the historical header to read it in-circuit.
        let threshold = self.storage.transfer_threshold.read();

        if amount > threshold {
            // Verify the full innocence proof inside the private circuit.
            // Returns claimed_root so the public phase can confirm it.
            self._verify_compliance_witness_private(sender, amount, compliance)
        } else {
            // No proof required. Return 0 as a sentinel.
            // _verify_compliance_root() skips the root check when amount <= threshold.
            0
        }
    }

    // =========================================================================
    // PUBLIC READERS
    // =========================================================================

    #[external("utility")]
    unconstrained fn private_balance_of(owner: AztecAddress) -> pub u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    #[external("utility")]
    unconstrained fn get_owner() -> pub AztecAddress {
        self.storage.owner.read()
    }

    #[external("utility")]
    unconstrained fn get_auditor() -> pub AztecAddress {
        self.storage.auditor.read()
    }

    #[external("utility")]
    unconstrained fn get_bad_list_root() -> pub Field {
        self.storage.bad_list_root.read()
    }

    #[external("utility")]
    unconstrained fn get_transfer_threshold() -> pub u64 {
        self.storage.transfer_threshold.read()
    }

    #[external("utility")]
    unconstrained fn is_registered(user: AztecAddress) -> pub bool {
        let key = self.storage.audit_keys.at(user).read();
        let mut registered = false;
        for i in 0..ENCRYPTED_KEY_SIZE {
            if key[i] != 0 { registered = true; }
        }
        registered
    }
}
