import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useVeilContext } from '../context/VeilContext';
import { formatHash, formatAmount } from '../lib/format';
import type { Inspection } from '../hooks/useVeil';
import s from './Inspect.module.css';

// ─── Sub-components ───────────────────────────────────────────────────────────

function LockedPill({ label }: { label: string }) {
    return (
        <div className={s.lockedPill}>
            <span className={s.lockIcon}>🔒</span>
            <span className={s.lockLabel}>{label}</span>
            <span className={s.lockStatus}>hidden</span>
        </div>
    );
}

function RevealedPill({ label, value, note }: { label: string; value: string; note?: string }) {
    return (
        <div className={s.revealedPill}>
            <span className={s.revealLabel}>{label}</span>
            <span className={s.revealValue}>{value}</span>
            {note && <span className={s.revealNote}>{note}</span>}
        </div>
    );
}

function ExposedPill({ label, value }: { label: string; value: string }) {
    return (
        <div className={s.exposedPill}>
            <span className={s.exposedIcon}>🔴</span>
            <span className={s.exposedLabel}>{label}</span>
            <span className={s.exposedValue}>{value}</span>
            <span className={s.exposedTag}>visible</span>
        </div>
    );
}

function HashList({ items, empty = 'none' }: { items: string[]; empty?: string }) {
    if (items.length === 0) {
        return <div className={s.hashEmpty}>{empty}</div>;
    }
    return (
        <div className={s.hashList}>
            {items.map((h, i) => (
                <div key={i} className={s.hashRow}>{formatHash(h, 10, 6)}</div>
            ))}
        </div>
    );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function NoInspection() {
    return (
        <div className={s.empty}>
            <div className={s.emptyIcon}>◎</div>
            <h2 className={s.emptyTitle}>No transaction to inspect</h2>
            <p className={s.emptyBody}>
                Make a private transfer first. After the transaction confirms,
                come back here to see exactly what an on-chain observer can — and cannot — read.
            </p>
            <Link to="/send" className={s.emptyCta}>Go to Send →</Link>
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Inspect() {
    const { inspections, setup } = useVeilContext();
    const { txHash } = useParams<{ txHash?: string }>();
    const [ethExpanded, setEthExpanded] = useState(false);

    const inspection: Inspection | undefined = txHash
        ? inspections.find((i) => i.txHash === txHash)
        : inspections.at(-1);

    if (!inspection) return <NoInspection />;

    const leaked = inspection.senderFound || inspection.recipientFound || inspection.amountFound;

    // Resolve human labels for addresses
    const senderLabel = setup
        ? inspection.senderAddr === setup.alice.toString() ? 'Alice'
        : inspection.senderAddr === setup.bob.toString()   ? 'Bob'
        : inspection.senderAddr === setup.owner.toString() ? 'Owner'
        : null
        : null;

    const recipientLabel = setup
        ? inspection.recipientAddr === setup.alice.toString() ? 'Alice'
        : inspection.recipientAddr === setup.bob.toString()   ? 'Bob'
        : inspection.recipientAddr === setup.owner.toString() ? 'Owner'
        : null
        : null;

    return (
        <div className={s.page}>

            {/* ── Summary card ── */}
            <div className={s.summary}>
                <div className={s.summaryLeft}>
                    <div className={s.summaryDir}>↑</div>
                    <div>
                        <div className={s.summaryAmount}>
                            {formatAmount(inspection.amount)}
                            <span className={s.summaryUnit}>VEIL</span>
                        </div>
                        <div className={s.summaryMeta}>
                            Block #{inspection.blockNumber ?? '?'} · {inspection.status} ·{' '}
                            <span className={s.summaryHash}>{formatHash(inspection.txHash)}</span>
                        </div>
                    </div>
                </div>
                <div className={`${s.summaryBadge} ${leaked ? s.summaryBadgeLeak : ''}`}>
                    {leaked ? '⚠ Leak detected' : '◈ Shielded'}
                </div>
            </div>

            {/* ── Side-by-side comparison ── */}
            <div className={s.comparison}>

                {/* LEFT — on-chain view */}
                <div className={s.colOnchain}>
                    <div className={s.colHeader}>
                        <span className={s.colIcon}>🌐</span>
                        <span className={s.colTitle}>On-chain</span>
                        <span className={s.colSub}>anyone can read</span>
                    </div>

                    <div className={s.colBody}>
                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>Sensitive fields</div>
                            <LockedPill label="Sender" />
                            <LockedPill label="Recipient" />
                            <LockedPill label="Amount" />
                        </div>

                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>
                                Note commitments ({inspection.noteHashes.length})
                            </div>
                            <HashList items={inspection.noteHashes} />
                            <div className={s.fieldHint}>
                                Encrypted commitments — indistinguishable from random numbers.
                            </div>
                        </div>

                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>
                                Nullifiers ({inspection.nullifiers.length})
                            </div>
                            <HashList items={inspection.nullifiers} />
                            <div className={s.fieldHint}>
                                Prove a note was spent without revealing which note or by whom.
                            </div>
                        </div>

                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>
                                Public data writes ({inspection.publicWrites.length})
                            </div>
                            <HashList
                                items={inspection.publicWrites.map(
                                    (w) => `slot ${formatHash(w.slot, 6, 4)} → ${formatHash(w.value, 6, 4)}`
                                )}
                                empty="none"
                            />
                        </div>

                        <div className={s.colFootnote}>
                            An observer sees that some shielded activity happened.
                            They cannot determine who sent, who received, or how much.
                        </div>
                    </div>
                </div>

                {/* RIGHT — decrypted view */}
                <div className={s.colDecrypted}>
                    <div className={s.colHeader}>
                        <span className={s.colIcon}>🔑</span>
                        <span className={s.colTitle}>Decrypted</span>
                        <span className={s.colSub}>with your viewing key</span>
                    </div>

                    <div className={s.colBody}>
                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>Sensitive fields</div>
                            <RevealedPill
                                label="Sender"
                                value={formatHash(inspection.senderAddr, 8, 6)}
                                note={senderLabel ?? undefined}
                            />
                            <RevealedPill
                                label="Recipient"
                                value={formatHash(inspection.recipientAddr, 8, 6)}
                                note={recipientLabel ?? undefined}
                            />
                            <RevealedPill
                                label="Amount"
                                value={`${formatAmount(inspection.amount)} VEIL`}
                            />
                        </div>

                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>Notes spent</div>
                            <div className={s.fieldHint}>
                                {inspection.nullifiers.length} note{inspection.nullifiers.length !== 1 ? 's' : ''} nullified.
                                Original values visible only via your viewing key.
                            </div>
                        </div>

                        <div className={s.fieldGroup}>
                            <div className={s.fieldLabel}>Notes created</div>
                            <div className={s.fieldHint}>
                                {inspection.noteHashes.length} encrypted note{inspection.noteHashes.length !== 1 ? 's' : ''} written to
                                the note hash tree. Recipient and sender (change) each receive one.
                            </div>
                        </div>

                        <div className={s.colFootnote}>
                            Only the sender, recipient, and — on formal request — the auditor can
                            perform this decryption. Anyone else decrypts to noise.
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Ethereum comparison (collapsible) ── */}
            <div className={s.ethCard}>
                <button
                    className={s.ethToggle}
                    onClick={() => setEthExpanded((v) => !v)}
                >
                    <span className={s.ethToggleIcon}>{ethExpanded ? '▾' : '▸'}</span>
                    What this would look like on Ethereum (ERC-20 USDC)
                </button>

                {ethExpanded && (
                    <div className={s.ethBody}>
                        <div className={s.ethNote}>
                            The same transfer on a transparent chain. Every field below is
                            visible to anyone who queries the RPC or opens Etherscan.
                        </div>
                        <div className={s.ethFields}>
                            <ExposedPill label="From"   value={formatHash(inspection.senderAddr, 8, 6)} />
                            <ExposedPill label="To"     value={formatHash(inspection.recipientAddr, 8, 6)} />
                            <ExposedPill label="Amount" value={`${formatAmount(inspection.amount)} USDC`} />
                            <ExposedPill label="Sender balance (before)"  value="—" />
                            <ExposedPill label="Recipient balance (after)" value="—" />
                        </div>
                        <div className={s.ethFootnote}>
                            Financial surveillance is trivial on transparent chains. Any wallet address
                            can be traced across every counterparty and amount, permanently.
                        </div>
                    </div>
                )}
            </div>

            {/* ── Verdict bar ── */}
            <div className={`${s.verdict} ${leaked ? s.verdictLeak : s.verdictShielded}`}>
                <span className={s.verdictIcon}>{leaked ? '⚠' : '◈'}</span>
                <div>
                    <div className={s.verdictTitle}>
                        {leaked
                            ? 'Leak detected'
                            : 'Fully shielded'}
                    </div>
                    <div className={s.verdictDetail}>
                        {leaked
                            ? [
                                inspection.senderFound    && 'sender address',
                                inspection.recipientFound && 'recipient address',
                                inspection.amountFound    && 'transfer amount',
                              ].filter(Boolean).join(', ') + ' found in public chain data'
                            : 'Sender, recipient and amount are not present anywhere in the public chain data for this transaction.'}
                    </div>
                </div>
            </div>

        </div>
    );
}
