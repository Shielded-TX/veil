import { useState, useCallback, useMemo } from 'react';
import { createAztecNodeClient, waitForNode, type AztecNode } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { type AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';

import { VeilContract } from '../../artifacts/Veil';
import {
    type ApprovedListTree,
    addDeposit,
    emptyTree,
    generateProof,
    getRoot,
    MERKLE_DEPTH,
} from '../../lib/merkle/src/tree';

const NODE_URL = 'http://localhost:8080';
const TRANSFER_THRESHOLD = 1000n;

type LogLevel = 'info' | 'ok' | 'warn' | 'bad';
interface LogEntry {
    time: string;
    msg: string;
    level: LogLevel;
}

interface Inspection {
    label: string;
    txHash: string;
    blockNumber: number | undefined;
    status: string;
    noteHashes: string[];
    nullifiers: string[];
    publicWrites: { slot: string; value: string }[];
    senderAddr: string;
    recipientAddr: string;
    amount: bigint;
    // The point: search the public data for these — they should not appear.
    senderFound: boolean;
    recipientFound: boolean;
    amountFound: boolean;
}

interface Setup {
    node: AztecNode;
    wallet: Awaited<ReturnType<typeof EmbeddedWallet.create>>;
    veil: VeilContract;
    owner: AztecAddress;
    alice: AztecAddress;
    bob: AztecAddress;
}

const short = (a: { toString(): string } | null | undefined): string => {
    if (!a) return '—';
    const s = a.toString();
    return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
};

const dummyAuditKey = (): Fr[] => [
    new Fr(1n),
    new Fr(2n),
    new Fr(3n),
    new Fr(4n),
];

const emptyProof = () => ({
    deposit_id: 0n,
    siblings: new Array(MERKLE_DEPTH).fill(new Fr(0n)) as Fr[],
    leaf_index: 0n,
});

function shortHex(s: string): string {
    if (!s.startsWith('0x') && /^\d+$/.test(s)) {
        try {
            const hex = BigInt(s).toString(16).padStart(64, '0');
            return `0x${hex.slice(0, 10)}…${hex.slice(-6)}`;
        } catch {
            return s;
        }
    }
    if (s.length > 18) return `${s.slice(0, 10)}…${s.slice(-6)}`;
    return s;
}

function PrivCheck({ label, found }: { label: string; found: boolean }) {
    return (
        <div style={{ marginBottom: 4 }}>
            <span style={{ color: found ? 'var(--bad)' : 'var(--good)' }}>
                {found ? '✗ FOUND' : '✓ not found'}
            </span>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{label}</span>
        </div>
    );
}

function RawList({ items }: { items: string[] }) {
    if (items.length === 0) {
        return (
            <div
                style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--muted)',
                }}
            >
                (none)
            </div>
        );
    }
    return (
        <div
            style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                background: 'var(--panel-2)',
                borderRadius: 4,
                padding: '6px 8px',
                maxHeight: 120,
                overflow: 'auto',
            }}
        >
            {items.map((it, i) => (
                <div key={i} style={{ overflowWrap: 'anywhere' }}>
                    {shortHex(it)}
                </div>
            ))}
        </div>
    );
}

// Pull a tx's public effects from the node and check whether the sender
// address, recipient address, or amount are anywhere in the public data.
// They should not be — that's what "shielded" means here.
async function inspectTx(
    node: AztecNode,
    label: string,
    txHash: { toString(): string },
    sender: AztecAddress,
    recipient: AztecAddress,
    amount: bigint,
): Promise<Inspection> {
    const [receipt, indexed] = await Promise.all([
        node.getTxReceipt(txHash as never),
        node.getTxEffect(txHash as never),
    ]);
    const eff = indexed?.data;
    const noteHashes = (eff?.noteHashes ?? []).map((h) => h.toString());
    const nullifiers = (eff?.nullifiers ?? []).map((n) => n.toString());
    const publicWrites = (eff?.publicDataWrites ?? []).map((w) => ({
        slot: w.leafSlot.toString(),
        value: w.value.toString(),
    }));

    const senderBig = BigInt(sender.toString());
    const recipientBig = BigInt(recipient.toString());

    const haystack = [...noteHashes, ...nullifiers, ...publicWrites.flatMap((w) => [w.slot, w.value])];
    const haystackBig = haystack.map((s) => {
        try {
            return BigInt(s);
        } catch {
            return -1n;
        }
    });

    const senderFound = haystackBig.includes(senderBig);
    const recipientFound = haystackBig.includes(recipientBig);
    const amountFound = haystackBig.includes(amount);

    return {
        label,
        txHash: txHash.toString(),
        blockNumber: receipt.blockNumber as number | undefined,
        status: String(receipt.status),
        noteHashes,
        nullifiers,
        publicWrites,
        senderAddr: sender.toString(),
        recipientAddr: recipient.toString(),
        amount,
        senderFound,
        recipientFound,
        amountFound,
    };
}

export function App() {
    const [setup, setSetup] = useState<Setup | null>(null);
    const [busy, setBusy] = useState(false);
    const [log, setLog] = useState<LogEntry[]>([]);
    const [tree, setTree] = useState<ApprovedListTree>(() => emptyTree());
    const [approvedDeposits, setApprovedDeposits] = useState<bigint[]>([]);
    const [inspections, setInspections] = useState<Inspection[]>([]);
    const inspection = inspections.length > 0 ? inspections[inspections.length - 1] : null;

    const [aliceBalance, setAliceBalance] = useState<bigint | null>(null);
    const [bobBalance, setBobBalance] = useState<bigint | null>(null);
    const [aliceRegistered, setAliceRegistered] = useState(false);
    const [bobRegistered, setBobRegistered] = useState(false);
    const [depositCounter, setDepositCounter] = useState<bigint>(0n);
    const [onChainRoot, setOnChainRoot] = useState<bigint>(0n);

    const [mintAmount, setMintAmount] = useState('5000');
    const [aliceSendAmount, setAliceSendAmount] = useState('500');
    const [bobSendAmount, setBobSendAmount] = useState('500');
    const [approveDepositId, setApproveDepositId] = useState('1');
    const [aliceProofId, setAliceProofId] = useState('1');
    const [bobProofId, setBobProofId] = useState('2');

    const [auditReason, setAuditReason] = useState('investigation #123');
    interface AuditRecord {
        target: 'alice' | 'bob';
        reasonHash: string;
        txHash: string;
        block: number | undefined;
        encryptedKey: string[];
        decryptedBalance: bigint;
    }
    const [auditDisclosure, setAuditDisclosure] = useState<AuditRecord | null>(null);
    const [auditLog, setAuditLog] = useState<{
        target: string;
        reasonHash: string;
        time: string;
    }[]>([]);

    const append = useCallback((msg: string, level: LogLevel = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLog((prev) => [...prev.slice(-200), { time, msg, level }]);
    }, []);

    const refresh = useCallback(
        async (s: Setup) => {
            const [aBal, bBal, aReg, bReg, counter, root] = await Promise.all([
                s.veil.methods.private_balance_of(s.alice).simulate({ from: s.alice }),
                s.veil.methods.private_balance_of(s.bob).simulate({ from: s.bob }),
                s.veil.methods.is_registered(s.alice).simulate({ from: s.owner }),
                s.veil.methods.is_registered(s.bob).simulate({ from: s.owner }),
                s.veil.methods.get_deposit_counter().simulate({ from: s.owner }),
                s.veil.methods.get_approved_list_root().simulate({ from: s.owner }),
            ]);
            setAliceBalance(aBal.result as bigint);
            setBobBalance(bBal.result as bigint);
            setAliceRegistered(Boolean(aReg.result));
            setBobRegistered(Boolean(bReg.result));
            setDepositCounter(counter.result as bigint);
            setOnChainRoot(root.result as bigint);
        },
        [],
    );

    const handle = useCallback(
        async (label: string, fn: () => Promise<void>) => {
            if (busy) return;
            setBusy(true);
            append(`▶ ${label}...`);
            try {
                await fn();
                append(`✓ ${label}`, 'ok');
            } catch (err) {
                append(`✗ ${label}: ${(err as Error).message.split('\n')[0]}`, 'bad');
            } finally {
                setBusy(false);
            }
        },
        [busy, append],
    );

    const doSetup = useCallback(() => {
        return handle('Connect, load accounts, deploy contract', async () => {
            append(`Connecting to ${NODE_URL}`);
            const node = createAztecNodeClient(NODE_URL);
            await waitForNode(node);

            const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
            const accounts = await getInitialTestAccountsData();
            const [ownerData, aliceData, bobData] = accounts.slice(0, 3);

            // Serialize: IndexedDB closes the tx between async ticks, so
            // running these in Promise.all can race and abort.
            const ownerMgr = await wallet.createSchnorrAccount(
                ownerData.secret,
                ownerData.salt,
                ownerData.signingKey,
            );
            const aliceMgr = await wallet.createSchnorrAccount(
                aliceData.secret,
                aliceData.salt,
                aliceData.signingKey,
            );
            const bobMgr = await wallet.createSchnorrAccount(
                bobData.secret,
                bobData.salt,
                bobData.signingKey,
            );

            const owner = ownerMgr.address;
            const alice = aliceMgr.address;
            const bob = bobMgr.address;

            append('Deploying Veil contract...');
            const { contract: veil } = await VeilContract.deploy(
                wallet,
                owner,
                owner, // owner doubles as auditor for the demo
                new Fr(0n),
                TRANSFER_THRESHOLD,
            ).send({ from: owner });
            append(`Deployed at ${short(veil.address)}`);

            const s: Setup = { node, wallet, veil, owner, alice, bob };
            setSetup(s);
            await refresh(s);
        });
    }, [handle, append, refresh]);

    const doRegister = useCallback(
        (who: 'alice' | 'bob') =>
            handle(`${who} registers for audit`, async () => {
                if (!setup) throw new Error('not set up');
                const from = who === 'alice' ? setup.alice : setup.bob;
                await setup.veil.methods
                    .register_for_audit(dummyAuditKey())
                    .send({ from });
                await refresh(setup);
            }),
        [handle, setup, refresh],
    );

    const doRequestAudit = useCallback(
        (target: 'alice' | 'bob') =>
            handle(`Auditor requests access to ${target}'s history`, async () => {
                if (!setup) throw new Error('not set up');
                const targetAddr = target === 'alice' ? setup.alice : setup.bob;

                // Hash the reason string into a Field. For the demo we just use
                // the bigint of the UTF-8 bytes truncated to 31 bytes (Fr is ~254 bits).
                const reasonBytes = new TextEncoder().encode(auditReason).slice(0, 31);
                let reasonBig = 0n;
                for (const b of reasonBytes) {
                    reasonBig = (reasonBig << 8n) | BigInt(b);
                }
                const reasonHash = new Fr(reasonBig);

                append(
                    `Submitting public audit request for ${target} (reason="${auditReason}")...`,
                );
                const result = await setup.veil.methods
                    .request_audit(targetAddr, reasonHash)
                    .send({ from: setup.owner });

                append(`Public AuditRequested event emitted (tx ${short(result.receipt.txHash)})`);
                setAuditLog((prev) => [
                    ...prev,
                    {
                        target,
                        reasonHash: reasonHash.toString(),
                        time: new Date().toLocaleTimeString(),
                    },
                ]);

                // The auditor can now read the encrypted audit-key blob from public
                // storage, then decrypt it OFF-CHAIN with their private key, then use
                // the decrypted viewing key to decrypt the user's notes. We simulate
                // those off-chain steps by also reading the user's private balance
                // (which the wallet has decryption keys for in this demo).
                append(`Reading encrypted audit-key blob from on-chain storage...`);
                // The audit key is stored at the contract; we just show what's there.
                // (For the dummy key we registered, this is [1, 2, 3, 4].)
                const encryptedKey = dummyAuditKey().map((f) => f.toString());

                const { result: balance } = await setup.veil.methods
                    .private_balance_of(targetAddr)
                    .simulate({ from: targetAddr });

                setAuditDisclosure({
                    target,
                    reasonHash: reasonHash.toString(),
                    txHash: result.receipt.txHash.toString(),
                    block: result.receipt.blockNumber as number | undefined,
                    encryptedKey,
                    decryptedBalance: balance as bigint,
                });
                append('Audit disclosure ready (auditor would do the decryption off-chain)');
            }),
        [handle, setup, auditReason, append],
    );

    const doMint = useCallback(
        (recipient: 'alice' | 'bob') =>
            handle(`Mint ${mintAmount} VEIL → ${recipient}`, async () => {
                if (!setup) throw new Error('not set up');
                const to = recipient === 'alice' ? setup.alice : setup.bob;
                await setup.veil.methods
                    .mint(to, BigInt(mintAmount))
                    .send({ from: setup.owner });
                await refresh(setup);
            }),
        [handle, setup, mintAmount, refresh],
    );

    const doApprove = useCallback(() => {
        return handle(`Auditor approves deposit ${approveDepositId}`, async () => {
            if (!setup) throw new Error('not set up');
            const id = BigInt(approveDepositId);
            const newTree = addDeposit(tree, id);
            const newRoot = getRoot(newTree);
            await setup.veil.methods
                .update_approved_list_root(newRoot)
                .send({ from: setup.owner });
            setTree(newTree);
            setApprovedDeposits((prev) => [...prev, id]);
            append(`Published new root: ${newRoot.toString()}`);
            await refresh(setup);
        });
    }, [handle, setup, approveDepositId, tree, refresh, append]);

    const doTransfer = useCallback(
        (sender: 'alice' | 'bob', amountStr: string, depositIdStr: string) =>
            handle(`${sender} sends ${amountStr} VEIL`, async () => {
                if (!setup) throw new Error('not set up');
                const from = sender === 'alice' ? setup.alice : setup.bob;
                const to = sender === 'alice' ? setup.bob : setup.alice;
                const amount = BigInt(amountStr);

                let proofArg;
                if (amount > TRANSFER_THRESHOLD) {
                    const id = BigInt(depositIdStr);
                    if (!approvedDeposits.includes(id)) {
                        append(
                            `(deposit ${id} not in approved list — proof will fail)`,
                            'warn',
                        );
                    }
                    append('Generating off-chain inclusion proof...');
                    const proof = generateProof(tree, id);
                    proofArg = {
                        deposit_id: proof.depositId,
                        siblings: proof.siblings,
                        leaf_index: BigInt(proof.leafIndex),
                    };
                    append(
                        `Proof: leaf_index=${proof.leafIndex}, ${proof.siblings.length} siblings`,
                    );
                } else {
                    proofArg = emptyProof();
                    append(`(below threshold — no proof needed)`);
                }

                const result = await setup.veil.methods
                    .private_transfer(to, amount, proofArg)
                    .send({ from });
                await refresh(setup);

                append('Inspecting on-chain effects of this tx...');
                try {
                    const insp = await inspectTx(
                        setup.node,
                        `${sender} → ${sender === 'alice' ? 'bob' : 'alice'} : ${amount}`,
                        result.receipt.txHash,
                        from,
                        to,
                        amount,
                    );
                    setInspections((prev) => [...prev, insp]);
                } catch (e) {
                    append(
                        `(could not fetch tx effects: ${(e as Error).message})`,
                        'warn',
                    );
                }
            }),
        [handle, setup, tree, approvedDeposits, refresh, append],
    );

    const connected = setup !== null;
    const rootHex = useMemo(() => {
        if (onChainRoot === 0n) return '(not set)';
        const hex = onChainRoot.toString(16).padStart(64, '0');
        return `0x${hex.slice(0, 10)}…${hex.slice(-6)}`;
    }, [onChainRoot]);

    return (
        <div className="app">
            <header>
                <div>
                    <h1>Veil</h1>
                    <div className="subtitle">
                        Privacy-preserving stablecoin with threshold-gated proof of innocence
                    </div>
                </div>
                <div className="status-bar">
                    <span className={`status-pill ${connected ? 'ok' : 'warn'}`}>
                        {connected ? '● connected' : '● disconnected'}
                    </span>
                    {busy && (
                        <span className="status-pill warn">
                            <span className="spinner" />
                            working
                        </span>
                    )}
                    {!connected && (
                        <button className="primary" onClick={doSetup} disabled={busy}>
                            Connect & deploy
                        </button>
                    )}
                </div>
            </header>

            {!connected ? (
                <div className="panel">
                    <h2>Get started</h2>
                    <p style={{ color: 'var(--muted)' }}>
                        Make sure the Aztec local network is running:
                    </p>
                    <pre
                        style={{
                            background: 'var(--panel-2)',
                            padding: '8px 12px',
                            borderRadius: 4,
                            fontFamily: 'var(--mono)',
                            fontSize: 12,
                        }}
                    >
                        aztec start --local-network
                    </pre>
                    <p style={{ color: 'var(--muted)' }}>
                        Then click <strong>Connect &amp; deploy</strong> in the top-right.
                    </p>
                </div>
            ) : (
                <main>
                    {/* OWNER + AUDITOR */}
                    <div className="panel">
                        <h2>Owner / Auditor</h2>
                        <div className="role">Mints VEIL · publishes approved-list root</div>
                        <div className="address">{setup.owner.toString()}</div>
                        <div className="balance-label">Public state</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, marginBottom: 12 }}>
                            <div>Deposit counter: <strong>{depositCounter.toString()}</strong></div>
                            <div>Threshold: <strong>{TRANSFER_THRESHOLD.toString()} VEIL</strong></div>
                        </div>

                        <div className="actions">
                            <div className="action-row">
                                <input
                                    value={mintAmount}
                                    onChange={(e) => setMintAmount(e.target.value)}
                                />
                                <button onClick={() => doMint('alice')} disabled={busy}>
                                    Mint → Alice
                                </button>
                                <button onClick={() => doMint('bob')} disabled={busy}>
                                    Mint → Bob
                                </button>
                            </div>

                            <div className="action-row" style={{ marginTop: 8 }}>
                                <input
                                    value={approveDepositId}
                                    onChange={(e) => setApproveDepositId(e.target.value)}
                                />
                                <button onClick={doApprove} disabled={busy}>
                                    Approve deposit ID
                                </button>
                            </div>
                        </div>

                        <div className="compliance-box">
                            <div className="label">On-chain approved root</div>
                            <div className="value">{rootHex}</div>
                            <div className="label" style={{ marginTop: 8 }}>
                                Approved deposits ({approvedDeposits.length})
                            </div>
                            <div className="value">
                                {approvedDeposits.length > 0
                                    ? approvedDeposits.map((d) => `#${d}`).join(', ')
                                    : '(none yet)'}
                            </div>
                        </div>

                        <div
                            style={{
                                marginTop: 16,
                                paddingTop: 16,
                                borderTop: '1px solid var(--border)',
                            }}
                        >
                            <div
                                className="balance-label"
                                style={{ marginBottom: 8 }}
                            >
                                Audit access
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <input
                                    style={{ width: '100%' }}
                                    value={auditReason}
                                    onChange={(e) => setAuditReason(e.target.value)}
                                    placeholder="Reason / case number"
                                />
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <button
                                        style={{ flex: 1 }}
                                        onClick={() => doRequestAudit('alice')}
                                        disabled={busy || !aliceRegistered}
                                    >
                                        Audit Alice
                                    </button>
                                    <button
                                        style={{ flex: 1 }}
                                        onClick={() => doRequestAudit('bob')}
                                        disabled={busy || !bobRegistered}
                                    >
                                        Audit Bob
                                    </button>
                                </div>
                                <span
                                    style={{
                                        color: 'var(--muted)',
                                        fontSize: 11,
                                        fontFamily: 'var(--mono)',
                                    }}
                                >
                                    ↑ emits a public AuditRequested event the user can see
                                </span>
                            </div>

                            {auditLog.length > 0 && (
                                <div className="compliance-box" style={{ marginTop: 12 }}>
                                    <div className="label">
                                        Audit request log ({auditLog.length})
                                    </div>
                                    {auditLog.slice(-5).reverse().map((r, i) => (
                                        <div
                                            key={i}
                                            className="value"
                                            style={{ fontSize: 11, marginTop: 4 }}
                                        >
                                            {r.time} · {r.target} · reason {shortHex(r.reasonHash)}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ALICE */}
                    <div className="panel">
                        <h2>Alice</h2>
                        <div className="role">
                            <span
                                className={`tag ${aliceRegistered ? 'registered' : 'unregistered'}`}
                            >
                                {aliceRegistered ? 'registered' : 'not registered'}
                            </span>
                        </div>
                        <div className="address">{setup.alice.toString()}</div>
                        <div className="balance-label">Private balance</div>
                        <div className={`balance ${aliceBalance === null ? 'muted' : ''}`}>
                            {aliceBalance !== null ? aliceBalance.toString() : '—'}
                        </div>

                        <div className="actions">
                            {!aliceRegistered ? (
                                <button
                                    className="primary"
                                    onClick={() => doRegister('alice')}
                                    disabled={busy}
                                >
                                    Register for audit
                                </button>
                            ) : (
                                <>
                                    <div className="action-row">
                                        <input
                                            value={aliceSendAmount}
                                            onChange={(e) => setAliceSendAmount(e.target.value)}
                                        />
                                        <button
                                            onClick={() =>
                                                doTransfer('alice', aliceSendAmount, aliceProofId)
                                            }
                                            disabled={busy}
                                        >
                                            Send → Bob
                                        </button>
                                    </div>
                                    <div className="action-row">
                                        <input
                                            value={aliceProofId}
                                            onChange={(e) => setAliceProofId(e.target.value)}
                                            placeholder="dep ID"
                                        />
                                        <span
                                            style={{
                                                color: 'var(--muted)',
                                                fontSize: 11,
                                                fontFamily: 'var(--mono)',
                                            }}
                                        >
                                            ↑ deposit ID for proof if amount &gt;{' '}
                                            {TRANSFER_THRESHOLD.toString()}
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* BOB */}
                    <div className="panel">
                        <h2>Bob</h2>
                        <div className="role">
                            <span
                                className={`tag ${bobRegistered ? 'registered' : 'unregistered'}`}
                            >
                                {bobRegistered ? 'registered' : 'not registered'}
                            </span>
                        </div>
                        <div className="address">{setup.bob.toString()}</div>
                        <div className="balance-label">Private balance</div>
                        <div className={`balance ${bobBalance === null ? 'muted' : ''}`}>
                            {bobBalance !== null ? bobBalance.toString() : '—'}
                        </div>

                        <div className="actions">
                            {!bobRegistered ? (
                                <button
                                    className="primary"
                                    onClick={() => doRegister('bob')}
                                    disabled={busy}
                                >
                                    Register for audit
                                </button>
                            ) : (
                                <>
                                    <div className="action-row">
                                        <input
                                            value={bobSendAmount}
                                            onChange={(e) => setBobSendAmount(e.target.value)}
                                        />
                                        <button
                                            onClick={() =>
                                                doTransfer('bob', bobSendAmount, bobProofId)
                                            }
                                            disabled={busy}
                                        >
                                            Send → Alice
                                        </button>
                                    </div>
                                    <div className="action-row">
                                        <input
                                            value={bobProofId}
                                            onChange={(e) => setBobProofId(e.target.value)}
                                            placeholder="dep ID"
                                        />
                                        <span
                                            style={{
                                                color: 'var(--muted)',
                                                fontSize: 11,
                                                fontFamily: 'var(--mono)',
                                            }}
                                        >
                                            ↑ deposit ID for proof if amount &gt;{' '}
                                            {TRANSFER_THRESHOLD.toString()}
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </main>
            )}

            {auditDisclosure && (
                <div
                    className="panel"
                    style={{
                        marginBottom: 16,
                        borderColor: 'var(--warn)',
                    }}
                >
                    <h2>
                        Audit disclosure ·{' '}
                        <span style={{ color: 'var(--warn)' }}>
                            {auditDisclosure.target}
                        </span>
                    </h2>
                    <div className="role">
                        After the public AuditRequested event, the auditor pulls the
                        encrypted audit-key blob from on-chain storage and decrypts it
                        off-chain. Below is what they learn.
                    </div>

                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 16,
                            marginTop: 12,
                        }}
                    >
                        <div>
                            <div className="balance-label">Public audit request</div>
                            <div
                                style={{
                                    fontFamily: 'var(--mono)',
                                    fontSize: 11,
                                    overflowWrap: 'anywhere',
                                    marginBottom: 8,
                                }}
                            >
                                tx: {auditDisclosure.txHash}
                            </div>
                            <div
                                style={{
                                    fontFamily: 'var(--mono)',
                                    fontSize: 12,
                                    marginBottom: 4,
                                }}
                            >
                                block: #{auditDisclosure.block ?? '?'}
                            </div>
                            <div
                                style={{
                                    fontFamily: 'var(--mono)',
                                    fontSize: 12,
                                    overflowWrap: 'anywhere',
                                }}
                            >
                                reason hash: {shortHex(auditDisclosure.reasonHash)}
                            </div>

                            <div className="balance-label" style={{ marginTop: 12 }}>
                                Encrypted audit-key blob (on-chain)
                            </div>
                            <RawList items={auditDisclosure.encryptedKey} />
                            <div
                                style={{
                                    color: 'var(--muted)',
                                    fontSize: 11,
                                    marginTop: 4,
                                    fontFamily: 'var(--mono)',
                                }}
                            >
                                ↑ in production, encrypted to the auditor's pubkey;
                                this demo registered a placeholder [1, 2, 3, 4]
                            </div>
                        </div>

                        <div>
                            <div className="balance-label">
                                After off-chain decryption, auditor learns:
                            </div>
                            <div
                                style={{
                                    background: 'var(--panel-2)',
                                    padding: '12px',
                                    borderRadius: 4,
                                    marginTop: 6,
                                }}
                            >
                                <div className="balance-label">Current balance</div>
                                <div
                                    style={{
                                        fontFamily: 'var(--mono)',
                                        fontSize: 22,
                                        fontWeight: 700,
                                    }}
                                >
                                    {auditDisclosure.decryptedBalance.toString()} VEIL
                                </div>
                                <div
                                    style={{
                                        color: 'var(--muted)',
                                        fontSize: 11,
                                        marginTop: 8,
                                        fontFamily: 'var(--mono)',
                                    }}
                                >
                                    Plus: every note involving this user becomes
                                    decryptable using the recovered viewing key.
                                </div>
                            </div>

                            <div className="balance-label" style={{ marginTop: 12 }}>
                                Decrypted transaction history
                            </div>
                            {(() => {
                                if (!setup) return null;
                                const s = setup;
                                const targetAddr =
                                    auditDisclosure.target === 'alice'
                                        ? s.alice.toString()
                                        : s.bob.toString();
                                const userTxs = inspections.filter(
                                    (i) =>
                                        i.senderAddr === targetAddr ||
                                        i.recipientAddr === targetAddr,
                                );
                                if (userTxs.length === 0) {
                                    return (
                                        <div
                                            style={{
                                                fontFamily: 'var(--mono)',
                                                fontSize: 11,
                                                color: 'var(--muted)',
                                                background: 'var(--panel-2)',
                                                padding: '8px 12px',
                                                borderRadius: 4,
                                            }}
                                        >
                                            (no transfers yet for this user)
                                        </div>
                                    );
                                }
                                return (
                                    <div
                                        style={{
                                            background: 'var(--panel-2)',
                                            borderRadius: 4,
                                            padding: '8px 12px',
                                            fontFamily: 'var(--mono)',
                                            fontSize: 11,
                                            maxHeight: 200,
                                            overflow: 'auto',
                                        }}
                                    >
                                        {userTxs.map((tx, i) => {
                                            const isSender = tx.senderAddr === targetAddr;
                                            const counterparty = isSender
                                                ? tx.recipientAddr
                                                : tx.senderAddr;
                                            const counterpartyLabel =
                                                counterparty === s.alice.toString()
                                                    ? 'alice'
                                                    : counterparty === s.bob.toString()
                                                      ? 'bob'
                                                      : shortHex(counterparty);
                                            return (
                                                <div
                                                    key={i}
                                                    style={{
                                                        padding: '4px 0',
                                                        borderBottom:
                                                            i < userTxs.length - 1
                                                                ? '1px solid var(--border)'
                                                                : 'none',
                                                    }}
                                                >
                                                    <span
                                                        style={{
                                                            color: isSender ? 'var(--bad)' : 'var(--good)',
                                                            fontWeight: 600,
                                                        }}
                                                    >
                                                        {isSender ? '→ sent' : '← received'}{' '}
                                                        {tx.amount.toString()} VEIL
                                                    </span>
                                                    <span
                                                        style={{
                                                            color: 'var(--muted)',
                                                            marginLeft: 8,
                                                        }}
                                                    >
                                                        {isSender ? 'to' : 'from'} {counterpartyLabel}
                                                    </span>
                                                    <div
                                                        style={{
                                                            color: 'var(--muted)',
                                                            fontSize: 10,
                                                            marginTop: 2,
                                                        }}
                                                    >
                                                        block #{tx.blockNumber ?? '?'} · tx{' '}
                                                        {shortHex(tx.txHash)}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })()}

                            <div
                                style={{
                                    color: 'var(--muted)',
                                    fontSize: 11,
                                    marginTop: 12,
                                    fontFamily: 'var(--mono)',
                                    lineHeight: 1.5,
                                }}
                            >
                                The user can rotate their audit key at any time by
                                calling <strong>rotate_audit_key</strong>, which limits
                                what a future audit can reveal — only the period covered
                                by the most recently registered key.
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {inspection && (
                <div className="panel" style={{ marginBottom: 16 }}>
                    <h2>Chain inspector</h2>
                    <div className="role">
                        What an outside observer sees on chain for the last transfer
                    </div>

                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 16,
                        }}
                    >
                        <div>
                            <div className="balance-label">Tx hash</div>
                            <div
                                style={{
                                    fontFamily: 'var(--mono)',
                                    fontSize: 11,
                                    overflowWrap: 'anywhere',
                                    marginBottom: 12,
                                }}
                            >
                                {inspection.txHash}
                            </div>
                            <div className="balance-label">Block / status</div>
                            <div
                                style={{
                                    fontFamily: 'var(--mono)',
                                    fontSize: 13,
                                    marginBottom: 12,
                                }}
                            >
                                #{inspection.blockNumber ?? '?'} · {inspection.status}
                            </div>

                            <div className="balance-label">Privacy check</div>
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                                <PrivCheck
                                    label="Sender address in public data"
                                    found={inspection.senderFound}
                                />
                                <PrivCheck
                                    label="Recipient address in public data"
                                    found={inspection.recipientFound}
                                />
                                <PrivCheck
                                    label={`Amount (${inspection.amount}) in public data`}
                                    found={inspection.amountFound}
                                />
                            </div>
                            <div
                                style={{
                                    color: 'var(--muted)',
                                    fontSize: 11,
                                    marginTop: 8,
                                    fontFamily: 'var(--mono)',
                                }}
                            >
                                {inspection.senderFound ||
                                inspection.recipientFound ||
                                inspection.amountFound
                                    ? '⚠ leak detected'
                                    : '✓ shielded — no plaintext leaked on-chain'}
                            </div>
                        </div>

                        <div>
                            <div className="balance-label">
                                noteHashes ({inspection.noteHashes.length})
                            </div>
                            <RawList items={inspection.noteHashes} />

                            <div className="balance-label" style={{ marginTop: 12 }}>
                                nullifiers ({inspection.nullifiers.length})
                            </div>
                            <RawList items={inspection.nullifiers} />

                            <div className="balance-label" style={{ marginTop: 12 }}>
                                publicDataWrites ({inspection.publicWrites.length})
                            </div>
                            <RawList
                                items={inspection.publicWrites.map(
                                    (w) => `slot=${shortHex(w.slot)} val=${shortHex(w.value)}`,
                                )}
                            />
                        </div>
                    </div>
                </div>
            )}

            <div className="log">
                <h3>Activity</h3>
                {log.length === 0 ? (
                    <div style={{ color: 'var(--muted)' }}>
                        Actions and contract calls will appear here.
                    </div>
                ) : (
                    log
                        .slice()
                        .reverse()
                        .map((e, i) => (
                            <div key={i} className={`log-entry ${e.level}`}>
                                <span className="time">{e.time}</span>
                                {e.msg}
                            </div>
                        ))
                )}
            </div>
        </div>
    );
}
