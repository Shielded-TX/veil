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

function emptyProof() {
    return {
        deposit_id: 0n,
        siblings: new Array(8).fill(new Fr(0n)) as Fr[],
        leaf_index: 0n,
    };
}

async function run() {
    console.log('--- Veil integration test ---');
    console.log('Connecting to node at', NODE_URL);

    const node = createAztecNodeClient(NODE_URL);
    await waitForNode(node);

    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    // Sandbox ships with 3 pre-funded accounts. We use one for owner+auditor
    // (the contract allows the same address in both roles) and the other two
    // for Alice and Bob.
    const accounts = await getInitialTestAccountsData();
    const [ownerData, aliceData, bobData] = accounts.slice(0, 3);

    const [ownerMgr, aliceMgr, bobMgr] = await Promise.all(
        [ownerData, aliceData, bobData].map((a) =>
            wallet.createSchnorrAccount(a.secret, a.salt, a.signingKey),
        ),
    );

    const owner = ownerMgr.address;
    const auditor = owner; // same account plays both roles for this test
    const alice = aliceMgr.address;
    const bob = bobMgr.address;

    console.log('owner+auditor :', owner.toString());
    console.log('alice         :', alice.toString());
    console.log('bob           :', bob.toString());

    // 1. Deploy
    console.log('\n[1] Deploying Veil contract...');
    const { contract: veil } = await VeilContract.deploy(
        wallet,
        owner,
        auditor,
        new Fr(0n),
        TRANSFER_THRESHOLD,
    ).send({ from: owner });
    console.log('    deployed at', veil.address.toString());

    // 2. Register Alice and Bob for audit
    console.log('\n[2] Registering Alice and Bob for audit...');
    await veil.methods.register_for_audit(dummyAuditKey()).send({ from: alice });
    await veil.methods.register_for_audit(dummyAuditKey()).send({ from: bob });

    const { result: aliceRegistered } = await veil.methods
        .is_registered(alice)
        .simulate({ from: alice });
    const { result: bobRegistered } = await veil.methods
        .is_registered(bob)
        .simulate({ from: bob });
    assert(aliceRegistered === true, 'Alice should be registered');
    assert(bobRegistered === true, 'Bob should be registered');
    console.log('    both registered');

    // 3. Owner mints 5000 to Alice → deposit ID 1
    console.log('\n[3] Owner mints 5000 VEIL to Alice...');
    await veil.methods.mint(alice, 5000n).send({ from: owner });

    const { result: aliceBal } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: counter } = await veil.methods
        .get_deposit_counter()
        .simulate({ from: owner });
    assert(aliceBal === 5000n, `Alice balance = ${aliceBal}, expected 5000`);
    assert(counter === 1n, `deposit counter = ${counter}, expected 1`);
    console.log('    alice balance = 5000, deposit counter = 1');

    // 4. Auditor builds the approved-list tree and publishes the root
    console.log('\n[4] Auditor publishes approved-list root for deposit 1...');
    const tree = buildTree([1n]);
    const root = getRoot(tree);
    console.log('    library root =', root.toString());

    await veil.methods
        .update_approved_list_root(root)
        .send({ from: auditor });

    const { result: onChainRoot } = await veil.methods
        .get_approved_list_root()
        .simulate({ from: auditor });
    console.log('    on-chain root  =', String(onChainRoot));
    console.log('    on-chain typeof =', typeof onChainRoot);
    const libRootBig = root.toBigInt();
    const onChainBig =
        typeof onChainRoot === 'bigint'
            ? onChainRoot
            : (onChainRoot as { toBigInt(): bigint }).toBigInt();
    assert(
        onChainBig === libRootBig,
        `on-chain root must match library root (lib=${libRootBig}, on-chain=${onChainBig})`,
    );
    console.log('    on-chain root matches');

    // 5. Alice generates an inclusion proof for deposit 1
    console.log('\n[5] Generating inclusion proof for deposit 1...');
    const proof = generateProof(tree, 1n);
    const innocenceProof = {
        deposit_id: proof.depositId,
        siblings: proof.siblings,
        leaf_index: BigInt(proof.leafIndex),
    };
    console.log('    leaf_index =', innocenceProof.leaf_index.toString());

    // 6. Alice transfers 2000 to Bob (above threshold) — proof must verify
    console.log('\n[6] Alice transfers 2000 VEIL to Bob (above threshold)...');
    await veil.methods
        .private_transfer(bob, 2000n, innocenceProof)
        .send({ from: alice });

    const { result: aliceAfter } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bobAfter } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    assert(aliceAfter === 3000n, `alice after = ${aliceAfter}, expected 3000`);
    assert(bobAfter === 2000n, `bob after = ${bobAfter}, expected 2000`);
    console.log('    alice = 3000, bob = 2000');

    // 7. Below-threshold transfer skips the proof check
    console.log('\n[7] Small transfer (500) does not need a real proof...');
    await veil.methods
        .private_transfer(bob, 500n, emptyProof())
        .send({ from: alice });
    const { result: aliceFinal } = await veil.methods
        .private_balance_of(alice)
        .simulate({ from: alice });
    const { result: bobFinal } = await veil.methods
        .private_balance_of(bob)
        .simulate({ from: bob });
    assert(aliceFinal === 2500n, `alice final = ${aliceFinal}, expected 2500`);
    assert(bobFinal === 2500n, `bob final = ${bobFinal}, expected 2500`);
    console.log('    alice = 2500, bob = 2500');

    // 8. Above-threshold transfer with a deliberately wrong proof must fail
    console.log('\n[8] Above-threshold transfer with bogus proof should fail...');
    let threw = false;
    try {
        await veil.methods
            .private_transfer(bob, 2000n, {
                deposit_id: 999n,
                siblings: new Array(8).fill(new Fr(0n)) as Fr[],
                leaf_index: 0n,
            })
            .send({ from: alice });
    } catch (err) {
        threw = true;
        console.log(
            '    rejected as expected:',
            (err as Error).message.split('\n')[0],
        );
    }
    assert(threw, 'bogus proof should have been rejected');

    console.log('\n=== ALL CHECKS PASSED ===');
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) {
        throw new Error(`Assertion failed: ${msg}`);
    }
}

run().catch((err) => {
    console.error('\n[FAIL]', err);
    process.exit(1);
});
