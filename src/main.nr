// Veil: a privacy-first shielded stablecoin contract
// Built on Aztec Network. Implements shielded transfers with audit compliance
// and threshold-gated proof-of-innocence (Buterin et al., 2023).

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
        protocol::{
            address::AztecAddress,
            hash::poseidon2_hash,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Map, Owned, PublicMutable},
    };
    use balance_set::BalanceSet;

    // Size of the encrypted viewing key blob, in field elements.
    // Set to 4 as a placeholder; the real size depends on the encryption scheme.
    global ENCRYPTED_KEY_SIZE: u32 = 4;

    // Depth of the approved-list Merkle tree. Supports 2^MERKLE_DEPTH deposits.
    // A depth of 8 supports 256 deposits, which is enough for a demo.
    // Production deployments would use depth 20 or higher.
    global MERKLE_DEPTH: u32 = 8;

    // ========================================================================
    // TYPES
    // ========================================================================

    // A record of a single mint event.
    // Stored publicly so the off-chain auditor can review which deposits exist
    // and decide which ones to add to the approved Merkle tree.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct DepositReceipt {
        pub recipient: AztecAddress,
        pub amount: u64,
        pub block_number: u32,
    }

    // A Merkle inclusion proof for the approved-list tree.
    // Proves that a specific deposit ID is in the tree whose root is approved_list_root.
    //
    // - deposit_id: the ID of the deposit being proven
    // - siblings: the sibling hashes along the path from leaf to root
    //   (siblings[0] is the bottom-most level, siblings[MERKLE_DEPTH-1] is the top)
    // - leaf_index: the index of the leaf in the tree, which encodes the path
    //   (bit i of leaf_index says whether the proof's hash at level i
    //    is the left child = 0 or the right child = 1)
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct InnocenceProof {
        pub deposit_id: u64,
        pub siblings: [Field; MERKLE_DEPTH],
        pub leaf_index: u64,
    }

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
        // The current approved-list Merkle root, set by the auditor.
        // Represents the deposits the auditor has reviewed and approved for
        // large transactions (the association set, per Buterin et al. 2023).
        approved_list_root: PublicMutable<Field, Context>,
        // The transfer amount above which proof-of-innocence is required
        transfer_threshold: PublicMutable<u64, Context>,
        // Counter for assigning unique IDs to each mint event.
        // Increments with every successful mint.
        deposit_counter: PublicMutable<u64, Context>,
        // Maps deposit ID to the recipient and amount of that mint event.
        // Used by the off-chain auditor to populate the approved Merkle tree.
        deposit_receipts: Map<u64, PublicMutable<DepositReceipt, Context>, Context>,
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
        block_number: u32,
    }

    // Emitted when a user withdraws private VEIL to a public address.
    // The amount and recipient are public. The sender stays private.
    #[event]
    struct Withdrawal {
        recipient: AztecAddress,
        amount: u64,
        block_number: u32,
    }

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    // Runs once at deploy time. Sets the owner, auditor, approved-list root,
    // threshold, and initialises the deposit counter to zero.
    #[external("public")]
    #[initializer]
    fn constructor(
        initial_owner: AztecAddress,
        initial_auditor: AztecAddress,
        initial_approved_list_root: Field,
        initial_transfer_threshold: u64,
    ) {
        self.storage.owner.write(initial_owner);
        self.storage.auditor.write(initial_auditor);
        self.storage.approved_list_root.write(initial_approved_list_root);
        self.storage.transfer_threshold.write(initial_transfer_threshold);
        self.storage.deposit_counter.write(0);
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

    // Verifies a Merkle inclusion proof against a known root.
    // Returns true if the leaf hashes up the path to produce the expected root.
    //
    // siblings[i] is the sibling hash at level i (0 = bottom of tree).
    // leaf_index encodes the path: bit i of the index says whether the
    // proof's hash at level i is the left child (0) or the right child (1).
    #[contract_library_method]
    fn _verify_merkle_proof(
        leaf: Field,
        siblings: [Field; MERKLE_DEPTH],
        leaf_index: u64,
        expected_root: Field,
    ) -> bool {
        let mut current_hash = leaf;
        let mut index = leaf_index;

        for i in 0..MERKLE_DEPTH {
            let sibling = siblings[i];
            let is_right_child = (index % 2) == 1;
            if is_right_child {
                // Current node is the right child; sibling goes on the left
                current_hash = poseidon2_hash([sibling, current_hash]);
            } else {
                // Current node is the left child; sibling goes on the right
                current_hash = poseidon2_hash([current_hash, sibling]);
            }
            index = index / 2;
        }

        current_hash == expected_root
    }

    // Checks whether a transfer requires proof-of-innocence, and if so verifies it.
    // Below the threshold, no check is performed.
    // Above the threshold, the user must prove their deposit ID is in the approved
    // Merkle tree (membership proof against approved_list_root).
    //
    // This implements the association set construction from Buterin et al. (2023):
    // the user proves their funds originate from a deposit the auditor has approved,
    // without revealing which other transactions they have made.
    #[external("public")]
    #[only_self]
    fn _check_threshold_compliance(amount: u64, proof: InnocenceProof) {
        let threshold = self.storage.transfer_threshold.read();
        if amount > threshold {
            let approved_list_root = self.storage.approved_list_root.read();
            assert(approved_list_root != 0, "Approved list root not set");

            // Hash the deposit ID to form the leaf
            let leaf = poseidon2_hash([proof.deposit_id as Field]);

            // Verify the Merkle inclusion proof
            let valid = _verify_merkle_proof(
                leaf,
                proof.siblings,
                proof.leaf_index,
                approved_list_root,
            );
            assert(valid, "Invalid proof of innocence: deposit not in approved list");
        }
    }

    // Increments the deposit counter and writes a deposit receipt for a new mint.
    #[external("public")]
    #[only_self]
    fn _record_deposit(recipient: AztecAddress, amount: u64) {
        let current_id = self.storage.deposit_counter.read();
        let next_id = current_id + 1;
        self.storage.deposit_counter.write(next_id);

        let receipt = DepositReceipt {
            recipient: recipient,
            amount: amount,
            block_number: self.context.block_number(),
        };
        self.storage.deposit_receipts.at(next_id).write(receipt);
    }

    // Emits the withdrawal event from public context.
    #[external("public")]
    #[only_self]
    fn _emit_withdrawal(recipient: AztecAddress, amount: u64) {
        self.emit(
            Withdrawal {
                recipient: recipient,
                amount: amount,
                block_number: self.context.block_number(),
            },
        );
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

        self.emit(
            AuditRequested {
                target_user: target_user,
                reason_hash: reason_hash,
                block_number: self.context.block_number(),
            },
        );
    }

    // ========================================================================
    // COMPLIANCE STATE UPDATES (auditor only)
    // ========================================================================

    // Auditor publishes a new approved-list Merkle root.
    // The root commits to the set of deposit IDs the auditor has approved
    // for large transactions, after off-chain due diligence.
    #[external("public")]
    fn update_approved_list_root(new_root: Field) {
        let auditor_addr = self.storage.auditor.read();
        assert_eq(self.msg_sender(), auditor_addr, "Only the auditor can update the approved list");
        self.storage.approved_list_root.write(new_root);
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
    // Each mint creates a public deposit receipt with a unique deposit ID.
    // The receipt is what the off-chain auditor uses to populate the approved list.
    #[external("private")]
    fn mint(recipient: AztecAddress, amount: u64) {
        self.enqueue_self._assert_is_owner(self.msg_sender());
        self.enqueue_self._assert_is_registered(recipient);

        // Record the deposit publicly with a unique ID
        self.enqueue_self._record_deposit(recipient, amount);

        self.storage.private_balances.at(recipient).add(amount as u128).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    // Send VEIL privately from sender to recipient.
    // Both must be registered. Above the threshold, an innocence proof is required.
    #[external("private")]
    fn private_transfer(recipient: AztecAddress, amount: u64, innocence_proof: InnocenceProof) {
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
    fn withdraw_to_public(amount: u64, recipient: AztecAddress, innocence_proof: InnocenceProof) {
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
    unconstrained fn get_approved_list_root() -> pub Field {
        self.storage.approved_list_root.read()
    }

    #[external("utility")]
    unconstrained fn get_transfer_threshold() -> pub u64 {
        self.storage.transfer_threshold.read()
    }

    #[external("utility")]
    unconstrained fn get_deposit_counter() -> pub u64 {
        self.storage.deposit_counter.read()
    }

    #[external("utility")]
    unconstrained fn get_deposit_receipt(deposit_id: u64) -> pub DepositReceipt {
        self.storage.deposit_receipts.at(deposit_id).read()
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
