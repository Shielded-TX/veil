import { useState, useCallback } from 'react';
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
} from '../../../lib/merkle/src/tree';

// ─── Constants ────────────────────────────────────────────────────────────────

export const NODE_URL = 'http://localhost:8080';
export const TRANSFER_THRESHOLD = 1000n;

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'ok' | 'warn' | 'bad';
export type Persona = 'alice' | 'bob' | 'owner';

export interface LogEntry {
    time: string;
    msg: string;
    level: LogLevel;
}

export interface Inspection {
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
    senderFound: boolean;
    recipientFound: boolean;
    amountFound: boolean;
}

export interface AuditRecord {
    target: 'alice' | 'bob';
    reasonHash: string;
    txHash: string;
    block: number | undefined;
    encryptedKey: string[];
    decryptedBalance: bigint;
}

export interface Setup {
    node: AztecNode;
    wallet: Awaited<ReturnType<typeof EmbeddedWallet.create>>;
    veil: VeilContract;
    owner: AztecAddress;
    alice: AztecAddress;
    bob: AztecAddress;
}

// ─── Internal utilities ───────────────────────────────────────────────────────

const dummyAuditKey = (): Fr[] => [new Fr(1n), new Fr(2n), new Fr(3n), new Fr(4n)];

const emptyProof = () => ({
    deposit_id: 0n,
    siblings: new Array(MERKLE_DEPTH).fill(new Fr(0n)) as Fr[],
    leaf_index: 0n,
});

async function fetchInspection(
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
    const noteHashes   = (eff?.noteHashes        ?? []).map((h: { toString(): string }) => h.toString());
    const nullifiers   = (eff?.nullifiers         ?? []).map((n: { toString(): string }) => n.toString());
    const publicWrites = (eff?.publicDataWrites   ?? []).map((w: { leafSlot: { toString(): string }; value: { toString(): string } }) => ({
        slot:  w.leafSlot.toString(),
        value: w.value.toString(),
    }));

    const senderBig    = BigInt(sender.toString());
    const recipientBig = BigInt(recipient.toString());
    const haystack     = [...noteHashes, ...nullifiers, ...publicWrites.flatMap((w) => [w.slot, w.value])];
    const haystackBig  = haystack.map((s) => { try { return BigInt(s); } catch { return -1n; } });

    return {
        label,
        txHash:      txHash.toString(),
        blockNumber: receipt.blockNumber as number | undefined,
        status:      String(receipt.status),
        noteHashes, nullifiers, publicWrites,
        senderAddr:    sender.toString(),
        recipientAddr: recipient.toString(),
        amount,
        senderFound:    haystackBig.includes(senderBig),
        recipientFound: haystackBig.includes(recipientBig),
        amountFound:    haystackBig.includes(amount),
    };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVeil() {
    // ── Connection ──────────────────────────────────────────────────────────
    const [setup,  setSetup]  = useState<Setup | null>(null);
    const [busy,   setBusy]   = useState(false);
    const [activePersona, setActivePersona] = useState<Persona>('alice');

    // ── Balances & registration ─────────────────────────────────────────────
    const [aliceBalance,    setAliceBalance]    = useState<bigint | null>(null);
    const [bobBalance,      setBobBalance]      = useState<bigint | null>(null);
    const [aliceRegistered, setAliceRegistered] = useState(false);
    const [bobRegistered,   setBobRegistered]   = useState(false);

    // ── Compliance ──────────────────────────────────────────────────────────
    const [depositCounter,   setDepositCounter]  = useState<bigint>(0n);
    const [onChainRoot,      setOnChainRoot]      = useState<bigint>(0n);
    const [approvedDeposits, setApprovedDeposits] = useState<bigint[]>([]);
    const [tree,             setTree]             = useState<ApprovedListTree>(() => emptyTree());

    // ── History ─────────────────────────────────────────────────────────────
    const [log,             setLog]             = useState<LogEntry[]>([]);
    const [inspections,     setInspections]     = useState<Inspection[]>([]);
    const [auditDisclosure, setAuditDisclosure] = useState<AuditRecord | null>(null);
    const [auditLog,        setAuditLog]        = useState<{ target: string; reasonHash: string; time: string }[]>([]);

    // ── Form state (kept in hook so pages stay stateless) ──────────────────
    const [mintAmount,        setMintAmount]        = useState('5000');
    const [approveDepositId,  setApproveDepositId]  = useState('1');
    const [auditReason,       setAuditReason]        = useState('investigation #123');

    // ── Derived ─────────────────────────────────────────────────────────────
    const connected = setup !== null;

    const activeAddress = setup
        ? activePersona === 'alice' ? setup.alice
        : activePersona === 'bob'   ? setup.bob
        : setup.owner
        : null;

    const activeBalance = activePersona === 'alice' ? aliceBalance
        : activePersona === 'bob' ? bobBalance
        : null; // owner has no private balance in the demo

    const isActiveRegistered = activePersona === 'alice' ? aliceRegistered
        : activePersona === 'bob' ? bobRegistered
        : true; // owner is implicitly always the auditor

    const isAuditor = !!(setup && activeAddress &&
        activeAddress.toString() === setup.owner.toString());

    // ── Logging ─────────────────────────────────────────────────────────────
    const append = useCallback((msg: string, level: LogLevel = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLog((prev) => [...prev.slice(-200), { time, msg, level }]);
    }, []);

    // ── State refresh ────────────────────────────────────────────────────────
    const refresh = useCallback(async (s: Setup) => {
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
    }, []);

    // ── Generic error wrapper ────────────────────────────────────────────────
    const handle = useCallback(async (label: string, fn: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        append(`▶ ${label}…`);
        try {
            await fn();
            append(`✓ ${label}`, 'ok');
        } catch (err) {
            append(`✗ ${label}: ${(err as Error).message.split('\n')[0]}`, 'bad');
        } finally {
            setBusy(false);
        }
    }, [busy, append]);

    // ── connect ──────────────────────────────────────────────────────────────
    const connect = useCallback((initialPersona: Persona = 'alice') =>
        handle('Connect, load accounts, deploy contract', async () => {
            append(`Connecting to ${NODE_URL}…`);
            const node = createAztecNodeClient(NODE_URL);
            await waitForNode(node);

            const wallet   = await EmbeddedWallet.create(node, { ephemeral: true });
            const accounts = await getInitialTestAccountsData();
            const [ownerData, aliceData, bobData] = accounts.slice(0, 3);

            // Serialize: IndexedDB closes the tx between async ticks.
            const ownerMgr = await wallet.createSchnorrAccount(ownerData.secret, ownerData.salt, ownerData.signingKey);
            const aliceMgr = await wallet.createSchnorrAccount(aliceData.secret, aliceData.salt, aliceData.signingKey);
            const bobMgr   = await wallet.createSchnorrAccount(bobData.secret,   bobData.salt,   bobData.signingKey);

            append('Deploying Veil contract…');
            const { contract: veil } = await VeilContract.deploy(
                wallet, ownerMgr.address, ownerMgr.address, new Fr(0n), TRANSFER_THRESHOLD,
            ).send({ from: ownerMgr.address });
            append(`Deployed at ${veil.address.toString().slice(0, 10)}…`);

            const s: Setup = {
                node, wallet, veil,
                owner: ownerMgr.address,
                alice: aliceMgr.address,
                bob:   bobMgr.address,
            };
            setSetup(s);
            setActivePersona(initialPersona);
            await refresh(s);
        }),
    [handle, append, refresh]);

    // ── register ─────────────────────────────────────────────────────────────
    const register = useCallback((who: 'alice' | 'bob') =>
        handle(`Register ${who} for audit`, async () => {
            if (!setup) throw new Error('Not connected');
            const from = who === 'alice' ? setup.alice : setup.bob;
            await setup.veil.methods.register_for_audit(dummyAuditKey()).send({ from });
            await refresh(setup);
        }),
    [handle, setup, refresh]);

    // ── mint ─────────────────────────────────────────────────────────────────
    const mint = useCallback((recipient: 'alice' | 'bob', amount: string) =>
        handle(`Mint ${amount} VEIL → ${recipient}`, async () => {
            if (!setup) throw new Error('Not connected');
            const to = recipient === 'alice' ? setup.alice : setup.bob;
            await setup.veil.methods.mint(to, BigInt(amount)).send({ from: setup.owner });
            await refresh(setup);
        }),
    [handle, setup, refresh]);

    // ── approveDeposit ───────────────────────────────────────────────────────
    const approveDeposit = useCallback((id: string) =>
        handle(`Approve deposit #${id}`, async () => {
            if (!setup) throw new Error('Not connected');
            const depositId = BigInt(id);
            const newTree   = addDeposit(tree, depositId);
            const newRoot   = getRoot(newTree);
            await setup.veil.methods.update_approved_list_root(newRoot).send({ from: setup.owner });
            setTree(newTree);
            setApprovedDeposits((prev) => [...prev, depositId]);
            append(`Published Merkle root: ${newRoot.toString().slice(0, 12)}…`);
            await refresh(setup);
        }),
    [handle, setup, tree, refresh, append]);

    // ── transfer ─────────────────────────────────────────────────────────────
    const transfer = useCallback((
        sender: 'alice' | 'bob',
        amountStr: string,
        depositIdStr: string,
    ) =>
        handle(`${sender} sends ${Number(amountStr).toLocaleString()} VEIL`, async () => {
            if (!setup) throw new Error('Not connected');
            const from   = sender === 'alice' ? setup.alice : setup.bob;
            const to     = sender === 'alice' ? setup.bob   : setup.alice;
            const amount = BigInt(amountStr);

            let proofArg;
            if (amount > TRANSFER_THRESHOLD) {
                const id = BigInt(depositIdStr);
                if (!approvedDeposits.includes(id)) {
                    append(`Deposit #${id} not in approved list — proof will fail on-chain`, 'warn');
                }
                append('Generating ZK inclusion proof…');
                const proof = generateProof(tree, id);
                proofArg = {
                    deposit_id: proof.depositId,
                    siblings:   proof.siblings,
                    leaf_index: BigInt(proof.leafIndex),
                };
                append(`Proof ready — leaf_index=${proof.leafIndex}`);
            } else {
                proofArg = emptyProof();
                append('Sub-threshold — no proof required');
            }

            const result = await setup.veil.methods
                .private_transfer(to, amount, proofArg)
                .send({ from });
            await refresh(setup);

            append('Fetching on-chain effects…');
            try {
                const insp = await fetchInspection(
                    setup.node,
                    `${sender} → ${sender === 'alice' ? 'bob' : 'alice'} : ${amount}`,
                    result.receipt.txHash,
                    from, to, amount,
                );
                setInspections((prev) => [...prev, insp]);
            } catch (e) {
                append(`Could not fetch tx effects: ${(e as Error).message}`, 'warn');
            }
        }),
    [handle, setup, tree, approvedDeposits, refresh, append]);

    // ── requestAudit ─────────────────────────────────────────────────────────
    const requestAudit = useCallback((target: 'alice' | 'bob', reason: string) =>
        handle(`Request audit: ${target}`, async () => {
            if (!setup) throw new Error('Not connected');
            const targetAddr = target === 'alice' ? setup.alice : setup.bob;

            const reasonBytes = new TextEncoder().encode(reason).slice(0, 31);
            let reasonBig = 0n;
            for (const b of reasonBytes) { reasonBig = (reasonBig << 8n) | BigInt(b); }
            const reasonHash = new Fr(reasonBig);

            const result = await setup.veil.methods
                .request_audit(targetAddr, reasonHash)
                .send({ from: setup.owner });

            append(`AuditRequested event emitted — tx ${result.receipt.txHash.toString().slice(0, 10)}…`);
            setAuditLog((prev) => [...prev, {
                target,
                reasonHash: reasonHash.toString(),
                time: new Date().toLocaleTimeString(),
            }]);

            const encryptedKey = dummyAuditKey().map((f) => f.toString());
            const { result: balance } = await setup.veil.methods
                .private_balance_of(targetAddr)
                .simulate({ from: targetAddr });

            setAuditDisclosure({
                target,
                reasonHash: reasonHash.toString(),
                txHash:     result.receipt.txHash.toString(),
                block:      result.receipt.blockNumber as number | undefined,
                encryptedKey,
                decryptedBalance: balance as bigint,
            });
        }),
    [handle, setup, append]);

    // ── inspectTransaction ───────────────────────────────────────────────────
    const inspectTransaction = useCallback(async (
        txHash: string,
        sender: AztecAddress,
        recipient: AztecAddress,
        amount: bigint,
    ): Promise<Inspection> => {
        if (!setup) throw new Error('Not connected');
        const insp = await fetchInspection(setup.node, txHash, { toString: () => txHash }, sender, recipient, amount);
        setInspections((prev) => [...prev, insp]);
        return insp;
    }, [setup]);

    return {
        // state
        setup, connected, busy, activePersona, setActivePersona,
        activeAddress, activeBalance, isActiveRegistered, isAuditor,
        aliceBalance, bobBalance, aliceRegistered, bobRegistered,
        depositCounter, onChainRoot, approvedDeposits, tree,
        log, inspections, auditDisclosure, auditLog,
        // form state
        mintAmount, setMintAmount,
        approveDepositId, setApproveDepositId,
        auditReason, setAuditReason,
        // actions
        connect, register, mint, transfer,
        approveDeposit, requestAudit, inspectTransaction,
        refresh: (s?: Setup) => refresh(s ?? setup!),
        append,
    };
}

export type VeilHook = ReturnType<typeof useVeil>;
