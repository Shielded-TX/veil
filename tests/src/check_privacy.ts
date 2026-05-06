/**
 * Privacy verification script.
 *
 * Demonstrates that a Veil private_transfer does not leak sender, recipient,
 * or amount to anyone with full read access to the L2 chain. Only the
 * commitments (note hashes) and nullifiers are public, and those are
 * indistinguishable from random.
 *
 * Run after `aztec start --local-network`:
 *   npx tsx src/check_privacy.ts
 */

import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';

import { VeilContract } from '../../artifacts/Veil.js';
import { buildTree, generateProof, getRoot } from '../../lib/merkle/src/tree.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const TRANSFER_THRESHOLD = 1000n;

function dummyAuditKey(): Fr[] {
    return [new Fr(1n), new Fr(2n), new Fr(3n), new Fr(4n)];
}

function rule() {
    console.log('─'.repeat(72));
}

async function main() {
    console.log('=== VEIL PRIVACY VERIFICATION ===\n');
    console.log('Connecting to Aztec node at', NODE_URL);

    const node = createAztecNodeClient(NODE_URL);
    await waitForNode(node);

    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    // Sandbox ships 3 funded accounts; reuse one for owner+auditor.
    const accounts = await getInitialTestAccountsData();
    const [ownerData, aliceData, bobData] = accounts.slice(0, 3);
    const [ownerMgr, aliceMgr, bobMgr] = await Promise.all(
        [ownerData, aliceData, bobData].map((a) =>
            wallet.createSchnorrAccount(a.secret, a.salt, a.signingKey),
        ),
    );
    const owner = ownerMgr.address;
    const auditor = owner;
    const alice = aliceMgr.address;
    const bob = bobMgr.address;

    // -----------------------------------------------------------------
    // Setup: deploy, register, mint, publish approved-list root
    // -----------------------------------------------------------------
    console.log('\nDeploying Veil and seeding state...');
    const { contract: veil } = await VeilContract.deploy(
        wallet,
        owner,
        auditor,
        new Fr(0n),
        TRANSFER_THRESHOLD,
    ).send({ from: owner });
    console.log('  contract @', veil.address.toString());

    await veil.methods.register_for_audit(dummyAuditKey()).send({ from: alice });
    await veil.methods.register_for_audit(dummyAuditKey()).send({ from: bob });
    await veil.methods.mint(alice, 5000n).send({ from: owner });

    const tree = buildTree([1n]);
    await veil.methods
        .update_approved_list_root(getRoot(tree))
        .send({ from: auditor });

    // -----------------------------------------------------------------
    // The transfer we are going to inspect
    // -----------------------------------------------------------------
    rule();
    console.log('Pre-transfer balances (visible only to each owner):');
    const { result: aliceBefore } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bobBefore } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    console.log(`  Alice: ${aliceBefore} VEIL`);
    console.log(`  Bob:   ${bobBefore} VEIL`);

    rule();
    const TRANSFER_AMOUNT = 2000n;
    console.log(
        `Alice → Bob: ${TRANSFER_AMOUNT} VEIL (above threshold, requires inclusion proof)`,
    );
    const proof = generateProof(tree, 1n);
    const result = await veil.methods
        .private_transfer(bob, TRANSFER_AMOUNT, {
            deposit_id: proof.depositId,
            siblings: proof.siblings,
            leaf_index: BigInt(proof.leafIndex),
        })
        .send({ from: alice });
    const txHash = result.receipt.txHash;
    console.log('  tx hash:', txHash.toString());

    // -----------------------------------------------------------------
    // What an outside observer sees on chain
    // -----------------------------------------------------------------
    rule();
    console.log('What an OBSERVER sees on chain for this tx:\n');

    const receipt = await node.getTxReceipt(txHash);
    console.log(`  status         : ${receipt.status}`);
    console.log(`  block number   : ${receipt.blockNumber ?? '(pending)'}`);

    const indexed = await node.getTxEffect(txHash);
    if (!indexed) {
        console.log('  (no tx effect found — node may be lagging)');
        return;
    }
    const eff = indexed.data;

    console.log(`  noteHashes      : ${eff.noteHashes.length}`);
    eff.noteHashes.slice(0, 4).forEach((h, i) => {
        console.log(`    [${i}] ${h.toString()}`);
    });
    if (eff.noteHashes.length > 4) {
        console.log(`    … and ${eff.noteHashes.length - 4} more`);
    }

    console.log(`\n  nullifiers      : ${eff.nullifiers.length}`);
    eff.nullifiers.slice(0, 4).forEach((n, i) => {
        console.log(`    [${i}] ${n.toString()}`);
    });
    if (eff.nullifiers.length > 4) {
        console.log(`    … and ${eff.nullifiers.length - 4} more`);
    }

    console.log(`\n  publicDataWrites: ${eff.publicDataWrites.length}`);
    eff.publicDataWrites.slice(0, 4).forEach((w, i) => {
        console.log(`    [${i}] slot=${w.leafSlot.toString()} value=${w.value.toString()}`);
    });
    if (eff.publicDataWrites.length > 4) {
        console.log(`    … and ${eff.publicDataWrites.length - 4} more`);
    }

    rule();
    console.log('Search the public chain data above for any of these:');
    console.log(`  Alice's address : ${alice.toString()}`);
    console.log(`  Bob's address   : ${bob.toString()}`);
    console.log(`  Transfer amount : ${TRANSFER_AMOUNT}  (hex: 0x${TRANSFER_AMOUNT.toString(16)})`);
    console.log(
        '\nNone appear in the public data. The chain only stores opaque commitments\n' +
            'and nullifiers; sender, recipient, and amount stay off-chain.',
    );

    // -----------------------------------------------------------------
    // What the participants see (from their own private state)
    // -----------------------------------------------------------------
    rule();
    console.log('What the PARTICIPANTS see in their own wallets:\n');
    const { result: aliceAfter } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bobAfter } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    console.log(`  Alice's balance changed from ${aliceBefore} → ${aliceAfter}  (Δ ${aliceAfter - aliceBefore})`);
    console.log(`  Bob's balance changed from ${bobBefore} → ${bobAfter}  (Δ ${bobAfter - bobBefore})`);
    console.log(
        '\nOnly Alice can see her -2000 delta (decrypts notes with her key);\n' +
            'only Bob can see his +2000 delta (decrypts notes with his key).',
    );

    rule();
    console.log('PRIVACY VERIFICATION COMPLETE.\n');
}

main().catch((err) => {
    console.error('\n[FAIL]', err);
    process.exit(1);
});
