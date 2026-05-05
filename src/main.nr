// Veil: a privacy-first shielded stablecoin contract
// Built on Aztec Network. Implements shielded transfers with audit compliance
// and threshold-gated proof-of-innocence (Buterin et al., 2023).

use aztec::macros::aztec;

#[aztec]
pub contract Veil {
    use aztec::{
        macros::{events::event, functions::{external, initializer, only_self}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Map, Owned, PublicMutable},
    };
    use balance_set::BalanceSet;

    // Size of the encrypted viewing key blob, in field elements.
    // Set to 4 as a placeholder; the real size depends on the encryption scheme.
    global ENCRYPTED_KEY_SIZE: u32 = 4;

    // ========================================================================
    // STORAGE
    // ========================================================================

    #[storage]
    struct Storage<Context> {
        // The address allowed to mint new VEIL tokens
        owner: PublicMutable<AztecAddress, Context>,
        // The address allowed to request audits and update compliance state
        auditor: PublicMutable<AztecAddress, Context>,
        // Private balances - only each user can see their own
        private_balances: Owned<BalanceSet<Context>, Context>,
        // Audit registry: each user's viewing key, encrypted to the auditor
        audit_keys: Map<AztecAddress, PublicMutable<[Field; ENCRYPTED_KEY_SIZE], Context>, Context>,
        // The current bad-list Merkle root, set by the auditor
        bad_list_root: PublicMutable<Field, Context>,
        // The transfer amount above which proof-of-innocence is required
        transfer_threshold: PublicMutable<u64, Context>,
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    // Emitted when the auditor requests access to a user's history.
    // Anyone monitoring the chain can see this. Users can react by rotating their key.
    #[event]
    struct AuditRequested {
        target_user: AztecAddress,
        reason_hash: Field,
        block_number: u64,
    }

    // Emitted when a user withdraws private VEIL to a public address.
    // The amount and recipient are public. The sender stays private.
    #[event]
    struct Withdrawal {
        recipient: AztecAddress,
        amount: u64,
        block_number: u64,
    }

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    // Runs once at deploy time. Sets the owner, auditor, bad-list root, and threshold.
    #[external("public")]
    #[initializer]
    fn constructor(
        initial_owner: AztecAddress,
        initial_auditor: AztecAddress,
        initial_bad_list_root: Field,
        initial_transfer_threshold: u64,
    ) {
        self.storage.owner.write(initial_owner);
        self.storage.auditor.write(initial_auditor);
        self.storage.bad_list_root.write(initial_bad_list_root);
        self.storage.transfer_threshold.write(initial_transfer_threshold);
    }

    // ========================================================================
    // INTERNAL HELPERS
    // ========================================================================

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
        let mut is_registered = false;
        for i in 0..ENCRYPTED_KEY_SIZE {
            if key[i] != 0 {
                is_registered = true;
            }
        }
        assert(is_registered, "User must register for audit before holding VEIL");
    }

    // Checks whether a transfer requires proof-of-innocence, and if so verifies it.
    // Below the threshold, no check is performed.
    // Above the threshold, the proof must be valid against the current bad-list root.
    //
    // PROTOTYPE PLACEHOLDER: A production deployment would verify a non-membership
    // Merkle proof of the sender's funds against bad_list_root inside the ZK circuit,
    // following Buterin et al. (2023). For this prototype, we accept any non-zero
    // proof value to demonstrate the threshold-gating mechanism.
    #[external("public")]
    #[only_self]
    fn _check_threshold_compliance(amount: u64, innocence_proof: Field) {
        let threshold = self.storage.transfer_threshold.read();
        if amount > threshold {
            let bad_list_root = self.storage.bad_list_root.read();
            assert(
                innocence_proof != 0,
                "Proof of innocence required for transfers above threshold",
            );
            assert(bad_list_root != 0, "Bad list root not set");
        }
    }

    // Emits the withdrawal event from public context.
    #[external("public")]
    #[only_self]
    fn _emit_withdrawal(recipient: AztecAddress, amount: u64) {
        Withdrawal {
            recipient: recipient,
            amount: amount,
            block_number: self.context.block_number(),
        }
            .emit();
    }

    // ========================================================================
    // AUDIT REGISTRY
    // ========================================================================

    // User registers their encrypted viewing key with the audit registry.
    // The key is encrypted off-chain by the user's wallet using the auditor's public key.
    // Calling this again overwrites the previous key (this is rotation).
    #[external("public")]
    fn register_for_audit(encrypted_key: [Field; ENCRYPTED_KEY_SIZE]) {
        let user = self.msg_sender();
        self.storage.audit_keys.at(user).write(encrypted_key);
    }

    // Alias for register_for_audit, for clearer call-site semantics on rotation.
    #[external("public")]
    fn rotate_audit_key(new_encrypted_key: [Field; ENCRYPTED_KEY_SIZE]) {
        let user = self.msg_sender();
        self.storage.audit_keys.at(user).write(new_encrypted_key);
    }

    // Auditor requests access to a specific user's transaction history.
    // Emits a public event so the user (and anyone watching) knows.
    #[external("public")]
    fn request_audit(target_user: AztecAddress, reason_hash: Field) {
        let auditor_addr = self.storage.auditor.read();
        assert_eq(self.msg_sender(), auditor_addr, "Only the auditor can request audits");

        let key = self.storage.audit_keys.at(target_user).read();
        let mut is_registered = false;
        for i in 0..ENCRYPTED_KEY_SIZE {
            if key[i] != 0 {
                is_registered = true;
            }
        }
        assert(is_registered, "Target user has not registered for audit");

        AuditRequested {
            target_user: target_user,
            reason_hash: reason_hash,
            block_number: self.context.block_number(),
        }
            .emit();
    }

    // ========================================================================
    // COMPLIANCE STATE UPDATES (auditor only)
    // ========================================================================

    // Auditor publishes a new bad-list Merkle root.
    #[external("public")]
    fn update_bad_list_root(new_root: Field) {
        let auditor_addr = self.storage.auditor.read();
        assert_eq(self.msg_sender(), auditor_addr, "Only the auditor can update the bad list");
        self.storage.bad_list_root.write(new_root);
    }

    // Auditor adjusts the threshold above which proof-of-innocence is required.
    #[external("public")]
    fn update_transfer_threshold(new_threshold: u64) {
        let auditor_addr = self.storage.auditor.read();
        assert_eq(self.msg_sender(), auditor_addr, "Only the auditor can update the threshold");
        self.storage.transfer_threshold.write(new_threshold);
    }

    // ========================================================================
    // CORE TOKEN OPERATIONS
    // ========================================================================

    // Owner mints new private VEIL tokens directly to a registered user.
    #[external("private")]
    fn mint(recipient: AztecAddress, amount: u64) {
        self.enqueue_self._assert_is_owner(self.msg_sender());
        self.enqueue_self._assert_is_registered(recipient);

        self.storage.private_balances.at(recipient).add(amount as u128).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    // Send VEIL privately from sender to recipient.
    // Both must be registered. Above the threshold, an innocence proof is required.
    #[external("private")]
    fn private_transfer(recipient: AztecAddress, amount: u64, innocence_proof: Field) {
        let sender = self.msg_sender();

        self.enqueue_self._assert_is_registered(sender);
        self.enqueue_self._assert_is_registered(recipient);
        self.enqueue_self._check_threshold_compliance(amount, innocence_proof);

        self.storage.private_balances.at(sender).sub(amount as u128).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );

        self.storage.private_balances.at(recipient).add(amount as u128).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    // Withdraw private VEIL to a public address.
    // The sender stays private. Amount and recipient become public.
    // Above the threshold, an innocence proof is required.
    #[external("private")]
    fn withdraw_to_public(amount: u64, recipient: AztecAddress, innocence_proof: Field) {
        let sender = self.msg_sender();

        self.enqueue_self._assert_is_registered(sender);
        self.enqueue_self._check_threshold_compliance(amount, innocence_proof);

        self.storage.private_balances.at(sender).sub(amount as u128).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );

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
        let mut is_registered = false;
        for i in 0..ENCRYPTED_KEY_SIZE {
            if key[i] != 0 {
                is_registered = true;
            }
        }
        is_registered
    }
}
