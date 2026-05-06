/**
 * Narrated end-to-end demo of the Veil contract.
 *
 * Walks through the full proof-of-innocence flow with plain-English narration
 * suitable for a screen recording.
 *
 * Run after `aztec start --local-network`:
 *   LOG_LEVEL=warn npx tsx src/demo.ts
 */

import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';

import { VeilContract } from '../../artifacts/Veil.js';
import { buildTree, generateProof, getRoot, addDeposit } from '../../lib/merkle/src/tree.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const TRANSFER_THRESHOLD = 1000n;

function dummyAuditKey(): Fr[] {
    return [new Fr(1n), new Fr(2n), new Fr(3n), new Fr(4n)];
}

function step(n: number, title: string) {
    console.log(`\n┌──── STEP ${n} ─────────────────────────────────────────────────────`);
    console.log(`│ ${title}`);
    console.log(`└─────────────────────────────────────────────────────────────────`);
}

function say(text: string) {
    console.log(`  ${text}`);
}

function pause(ms = 700) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║         VEIL — privacy-preserving stablecoin demo            ║');
    console.log('║                                                               ║');
    console.log('║  Shielded transfers, audit registry, threshold-gated          ║');
    console.log('║  proof of innocence (after Buterin et al., 2023)              ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');

    say(`\nConnecting to local Aztec node at ${NODE_URL}...`);
    const node = createAztecNodeClient(NODE_URL);
    await waitForNode(node);
    say('Connected.');

    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
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

    say('Loaded three accounts:');
    say(`  • Owner / Auditor : ${owner.toString().slice(0, 14)}…`);
    say(`  • Alice           : ${alice.toString().slice(0, 14)}…`);
    say(`  • Bob             : ${bob.toString().slice(0, 14)}…`);

    // ---------------------------------------------------------------
    step(1, 'Deploy the Veil contract');
    say('The contract takes four arguments at deploy time:');
    say('  - owner address  (can mint)');
    say('  - auditor address (can publish approved-list root)');
    say('  - initial Merkle root (zero — no approved deposits yet)');
    say(`  - transfer threshold = ${TRANSFER_THRESHOLD} VEIL`);
    say('Below the threshold, transfers are unrestricted.');
    say('Above the threshold, the sender must prove their funds');
    say('originate from a deposit the auditor has approved.\n');

    const { contract: veil } = await VeilContract.deploy(
        wallet,
        owner,
        auditor,
        new Fr(0n),
        TRANSFER_THRESHOLD,
    ).send({ from: owner });
    say(`Deployed at ${veil.address.toString()}`);
    await pause();

    // ---------------------------------------------------------------
    step(2, 'Alice and Bob register for audit');
    say('Each user must register an encrypted viewing key with the contract');
    say('before they can hold or send VEIL. The key is encrypted off-chain');
    say('to the auditor\'s public key — only the auditor can ever decrypt it,');
    say('and only after a public on-chain audit request that the user can see.\n');

    await veil.methods.register_for_audit(dummyAuditKey()).send({ from: alice });
    say('Alice registered.');
    await veil.methods.register_for_audit(dummyAuditKey()).send({ from: bob });
    say('Bob registered.');
    await pause();

    // ---------------------------------------------------------------
    step(3, 'Owner mints 5000 VEIL to Alice');
    say('Each mint:');
    say('  - increases the recipient\'s private balance');
    say('  - increments a public deposit counter');
    say('  - writes a public deposit receipt with the recipient and amount.\n');
    say('The receipt is what the auditor uses off-chain to decide whether');
    say('to add this deposit to the approved list.\n');

    await veil.methods.mint(alice, 5000n).send({ from: owner });
    const { result: aliceBal } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: counter } = await veil.methods
        .get_deposit_counter()
        .simulate({ from: owner });
    say(`Alice's private balance : ${aliceBal} VEIL`);
    say(`Public deposit counter  : ${counter}`);
    await pause();

    // ---------------------------------------------------------------
    step(4, 'Auditor publishes the approved-list Merkle root');
    say('Off-chain, the auditor reviews the public deposit receipts and');
    say('decides which deposits are "clean". They build a Merkle tree of');
    say('approved deposit IDs, and publish the root on-chain.\n');
    say('Building tree containing deposit ID 1...');

    const tree = buildTree([1n]);
    const root = getRoot(tree);
    say(`Tree root: ${root.toString()}`);

    await veil.methods.update_approved_list_root(root).send({ from: auditor });
    const { result: onChainRoot } = await veil.methods
        .get_approved_list_root()
        .simulate({ from: auditor });
    say(`On-chain root matches : ${onChainRoot === root.toBigInt() ? 'YES' : 'NO'}`);
    await pause();

    // ---------------------------------------------------------------
    step(5, 'Alice sends 2000 VEIL to Bob — ABOVE threshold');
    say('This is the cryptographic core. Alice must prove that her funds');
    say('come from an approved deposit, WITHOUT revealing which deposit it is.');
    say('She does this by generating a Merkle inclusion proof off-chain and');
    say('passing it as an argument. The contract recomputes the path on-chain;');
    say('if the path produces the published root, the transfer is allowed.\n');

    say('Generating off-chain inclusion proof for deposit 1...');
    const proof = generateProof(tree, 1n);
    say(`  leaf index : ${proof.leafIndex}`);
    say(`  siblings   : ${proof.siblings.length} field elements`);

    say('\nSending transfer with the proof attached...');
    await veil.methods
        .private_transfer(bob, 2000n, {
            deposit_id: proof.depositId,
            siblings: proof.siblings,
            leaf_index: BigInt(proof.leafIndex),
        })
        .send({ from: alice });

    const { result: aliceAfter } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bobAfter } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    say(`Alice's balance: 5000 → ${aliceAfter}`);
    say(`Bob's balance  :   0  → ${bobAfter}`);
    say('\nProof verified on-chain. Transfer succeeded.');
    await pause();

    // ---------------------------------------------------------------
    step(6, 'Alice sends 500 VEIL to Bob — BELOW threshold (no proof needed)');
    say('Below the threshold the contract does not require a proof at all.');
    say('Small transactions are unrestricted to keep everyday usage cheap.\n');

    await veil.methods
        .private_transfer(bob, 500n, {
            deposit_id: 0n,
            siblings: new Array(8).fill(new Fr(0n)) as Fr[],
            leaf_index: 0n,
        })
        .send({ from: alice });

    const { result: aliceAfter2 } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bobAfter2 } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    say(`Alice's balance: ${aliceAfter} → ${aliceAfter2}`);
    say(`Bob's balance  : ${bobAfter} → ${bobAfter2}`);
    await pause();

    // ---------------------------------------------------------------
    step(7, 'Attempt a large transfer with a BOGUS proof');
    say('What happens if Alice tries to claim her funds came from a deposit');
    say('that does not exist in the approved tree? The verifier rejects.\n');

    let rejected = false;
    try {
        await veil.methods
            .private_transfer(bob, 2000n, {
                deposit_id: 999n,
                siblings: new Array(8).fill(new Fr(0n)) as Fr[],
                leaf_index: 0n,
            })
            .send({ from: alice });
    } catch (err) {
        rejected = true;
        const msg = (err as Error).message.split('\n')[0];
        say(`Rejected: ${msg}`);
    }
    if (!rejected) {
        say('UNEXPECTED: bogus proof was accepted!');
    }
    await pause();

    // ---------------------------------------------------------------
    step(8, 'Auditor adds another deposit and rotates the root');
    say('When new deposits arrive, the auditor adds the approved ones to the');
    say('Merkle tree and publishes the new root. Old proofs become invalid');
    say('automatically because the root has changed.\n');

    say('Owner mints 3000 VEIL to Bob (creates deposit 2)...');
    await veil.methods.mint(bob, 3000n).send({ from: owner });

    say('Auditor adds deposit 2 to the approved tree...');
    const tree2 = addDeposit(tree, 2n);
    const root2 = getRoot(tree2);

    await veil.methods.update_approved_list_root(root2).send({ from: auditor });
    say(`New on-chain root: ${root2.toString()}`);
    say('\nNow Bob, who holds deposit 2, can also transfer above the threshold.');
    await pause();

    // ---------------------------------------------------------------
    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    DEMO COMPLETE                              ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('\nFinal balances:');
    const { result: aFinal } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bFinal } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    console.log(`  Alice: ${aFinal} VEIL`);
    console.log(`  Bob:   ${bFinal} VEIL`);
    console.log('\nKey takeaways:');
    console.log('  ✓ Balances are private — only owners see their own.');
    console.log('  ✓ Above-threshold transfers require a verifiable provenance proof.');
    console.log('  ✓ The proof reveals only "this came from an approved deposit",');
    console.log('    not WHICH deposit — preserving sender privacy.');
    console.log('  ✓ The contract enforces the rule cryptographically; no');
    console.log('    trust in any operator is required.');
    console.log();
}

main().catch((err) => {
    console.error('\n[DEMO FAILED]', err);
    process.exit(1);
});
