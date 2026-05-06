// Veil: privacy-first shielded stablecoin -- Aztec Network v4.2.0
//
// Compliance architecture (Privacy Pools, Buterin et al. 2023):
//
//   Sub-threshold transfers  -- pass claimed_root = 0, no proof needed.
//   Above-threshold transfers -- wallet generates an innocence proof locally
//     against the current bad_list_root, then calls the contract with the
//     claimed_root as a public input to that proof. The private function
//     verifies the proof via oracle (INTEGRATION POINT below). An enqueued
//     public call then confirms claimed_root matches the stored root so that
//     proofs made against stale roots are rejected by the sequencer.
//
// NoteWitness / NonMembershipWitness / ComplianceWitness are intentionally
// NOT defined here. They are private inputs to the innocence_proof.nr circuit
// and never cross the contract boundary. The contract only sees claimed_root
// (a single Field -- the public input to the proof).

use ::aztec::macros::aztec;

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
        state_vars::{Map, Owned, PublicMutable},
    };
    use balance_set::BalanceSet;

    // ========================================================================
    // STORAGE
    // Literal 4 for audit key array -- module-level globals do not resolve
    // inside #[storage] field type annotations in Aztec 4.2.0.
    // ========================================================================

    #[storage]
    struct Storage<Context> {
        owner:              PublicMutable<AztecAddress, Context>,
        auditor:            PublicMutable<AztecAddress, Context>,
        private_balances:   Owned<BalanceSet<Context>, Context>,
        // 4-element Field array holds the viewing key ciphertext (one element
        // per 32-byte chunk of the encrypted key blob).
        audit_keys:         Map<AztecAddress, PublicMutable<[Field; 4], Context>, Context>,
        bad_list_root:      PublicMutable<Field, Context>,
        transfer_threshold: PublicMutable<u64, Context>,
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    // Emitted when the auditor triggers a public audit request.
    // Anyone watching the chain sees this. Users should rotate their key.
    #[event]
    struct AuditRequested {
        target_user:  AztecAddress,
        reason_hash:  Field,
        block_number: u32,
    }

    // Emitted on private -> public withdrawal.
    // Amount and recipient become public; sender stays private.
    #[event]
    struct Withdrawal {
        recipient:    AztecAddress,
        amount:       u64,
        block_number: u32,
    }

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

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

    // ========================================================================
    // PUBLIC HELPERS -- enqueued by private functions, run on the sequencer
    // ========================================================================

    #[external("public")]
    #[only_self]
    fn _assert_is_owner(address: AztecAddress) {
        assert_eq(address, self.storage.owner.read(), "Only the owner can mint");
    }

    #[external("public")]
    #[only_self]
    fn _assert_is_registered(user: AztecAddress) {
        let key: [Field; 4] = self.storage.audit_keys.at(user).read();
        let mut ok = false;
        for i in 0..4 { if key[i] != 0 { ok = true; } }
        assert(ok, "User must register for audit before holding VEIL");
    }

    // Confirms the bad-list root the private proof was generated against
    // matches the root currently stored on chain.
    //
    // WHY: The innocence proof is verified locally against witness.claimed_root.
    // Without this check a user could submit a valid proof against a stale root
    // (from before their address was added to the bad list). This call runs on
    // the sequencer after private execution and rejects the tx if the auditor
    // has since rotated the root. Users must re-prove against the new root.
    //
    // When amount <= threshold, claimed_root = 0 and the check is skipped.
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
                "Proof made against stale bad-list root -- re-prove against current root",
            );
        }
    }

    #[external("public")]
    #[only_self]
    fn _emit_withdrawal(recipient: AztecAddress, amount: u64) {
        self.emit(Withdrawal {
            recipient,
            amount,
            block_number: self.context.block_number(),
        });
    }

    // ========================================================================
    // AUDIT REGISTRY
    // ========================================================================

    // Store an encrypted viewing key. Encrypted off-chain by the wallet to the
    // auditor's public key. Calling again overwrites (key rotation).
    #[external("public")]
    fn register_for_audit(encrypted_key: [Field; 4]) {
        self.storage.audit_keys.at(self.msg_sender()).write(encrypted_key);
    }

    #[external("public")]
    fn rotate_audit_key(new_encrypted_key: [Field; 4]) {
        self.storage.audit_keys.at(self.msg_sender()).write(new_encrypted_key);
    }

    // Auditor triggers a public audit event on a registered user.
    #[external("public")]
    fn request_audit(target_user: AztecAddress, reason_hash: Field) {
        assert_eq(
            self.msg_sender(), self.storage.auditor.read(),
            "Only the auditor can request audits",
        );
        let key: [Field; 4] = self.storage.audit_keys.at(target_user).read();
        let mut ok = false;
        for i in 0..4 { if key[i] != 0 { ok = true; } }
        assert(ok, "Target user has not registered for audit");
        self.emit(AuditRequested {
            target_user,
            reason_hash,
            block_number: self.context.block_number(),
        });
    }

    // ========================================================================
    // COMPLIANCE STATE UPDATES (auditor only)
    // ========================================================================

    #[external("public")]
    fn update_bad_list_root(new_root: Field) {
        assert_eq(self.msg_sender(), self.storage.auditor.read(), "Only auditor");
        self.storage.bad_list_root.write(new_root);
    }

    #[external("public")]
    fn update_transfer_threshold(new_threshold: u64) {
        assert_eq(self.msg_sender(), self.storage.auditor.read(), "Only auditor");
        self.storage.transfer_threshold.write(new_threshold);
    }

    // ========================================================================
    // CORE TOKEN OPERATIONS
    // ========================================================================

    #[external("private")]
    fn mint(recipient: AztecAddress, amount: u64) {
        self.enqueue_self._assert_is_owner(self.msg_sender());
        self.enqueue_self._assert_is_registered(recipient);
        self.storage.private_balances.at(recipient)
            .add(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    // Transfer VEIL privately.
    //
    // claimed_root: the bad-list root the wallet proved innocence against.
    //   Pass 0 for sub-threshold transfers (no proof generated).
    //   Pass the current bad_list_root for above-threshold transfers.
    //
    // INTEGRATION POINT: add the oracle call below once innocence_proof.nr
    // is compiled and its verifying key is registered:
    //
    //   if amount > threshold {
    //       innocence_proof::verify(
    //           self.context.historical_header().state().partial()
    //               .note_hash_tree().root(),  // note hash tree root
    //           claimed_root,                   // bad-list root (public input)
    //           amount,                         // transfer amount (public input)
    //           self.context.msg_sender().to_field() // sender (public input)
    //           // NoteWitness[] and NonMembershipWitness[] are PRIVATE inputs
    //           // held by the wallet -- they never appear in the fn signature.
    //       );
    //   }
    #[external("private")]
    fn private_transfer(
        recipient:    AztecAddress,
        amount:       u64,
        claimed_root: Field,
    ) {
        let sender = self.msg_sender();

        self.enqueue_self._assert_is_registered(sender);
        self.enqueue_self._assert_is_registered(recipient);

        // Threshold check and claimed_root enforcement are handled by the
        // enqueued public call _verify_compliance_root below.
        self.enqueue_self._verify_compliance_root(amount, claimed_root);

        self.storage.private_balances.at(sender)
            .sub(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        self.storage.private_balances.at(recipient)
            .add(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    // Exit private VEIL to a public address.
    // Sender stays private. Amount and recipient become public via event.
    #[external("private")]
    fn withdraw_to_public(
        amount:       u64,
        recipient:    AztecAddress,
        claimed_root: Field,
    ) {
        let sender = self.msg_sender();

        self.enqueue_self._assert_is_registered(sender);

        // Threshold check and claimed_root enforcement are handled by the
        // enqueued public call _verify_compliance_root below.
        self.enqueue_self._verify_compliance_root(amount, claimed_root);

        self.storage.private_balances.at(sender)
            .sub(amount as u128)
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        self.enqueue_self._emit_withdrawal(recipient, amount);
    }

    // ========================================================================
    // PUBLIC READERS
    // ========================================================================

    #[external("utility")]
    unconstrained fn private_balance_of(owner: AztecAddress) -> pub u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    #[external("utility")]
    unconstrained fn get_owner() -> pub AztecAddress { self.storage.owner.read() }

    #[external("utility")]
    unconstrained fn get_auditor() -> pub AztecAddress { self.storage.auditor.read() }

    #[external("utility")]
    unconstrained fn get_bad_list_root() -> pub Field { self.storage.bad_list_root.read() }

    #[external("utility")]
    unconstrained fn get_transfer_threshold() -> pub u64 { self.storage.transfer_threshold.read() }

    #[external("utility")]
    unconstrained fn is_registered(user: AztecAddress) -> pub bool {
        let key: [Field; 4] = self.storage.audit_keys.at(user).read();
        let mut ok = false;
        for i in 0..4 { if key[i] != 0 { ok = true; } }
        ok
    }
}
