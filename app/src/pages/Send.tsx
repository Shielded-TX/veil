import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVeilContext } from '../context/VeilContext';
import { Card, CardBody, CardHeader } from '../components/Card/Card';
import { AmountInput } from '../components/AmountInput/AmountInput';
import { ProofStatus, type ProofStage } from '../components/ProofStatus/ProofStatus';
import { HashBadge } from '../components/HashBadge/HashBadge';
import { TRANSFER_THRESHOLD } from '../hooks/useVeil';
import s from './Send.module.css';

export function Send() {
    const {
        activePersona, activeBalance, isActiveRegistered,
        setup, transfer, busy, log, inspections,
    } = useVeilContext();

    const navigate = useNavigate();
    const [amount,    setAmount]    = useState('');
    const [depositId, setDepositId] = useState('1');
    const [stage,     setStage]     = useState<ProofStage>('idle');

    const sender = activePersona === 'bob' ? 'bob' : 'alice';
    const toName = sender === 'alice' ? 'Bob' : 'Alice';

    const amountBig  = (() => { try { return amount ? BigInt(amount) : 0n; } catch { return 0n; } })();
    const needsProof = amountBig > TRANSFER_THRESHOLD;

    // Derive proof stage from log and busy state
    useEffect(() => {
        if (!busy) { setStage('idle'); return; }
        const last = log.at(-1)?.msg ?? '';
        if (last.includes('inclusion proof'))  setStage('building');
        else if (last.includes('Proof ready')) setStage('proving');
        else if (last.includes('sends'))       setStage('submitting');
        else if (busy)                         setStage('building');
    }, [busy, log]);

    // Navigate to inspector after transfer completes
    const prevInspCount = inspections.length;
    useEffect(() => {
        if (!busy && inspections.length > prevInspCount) {
            navigate('/inspect');
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [busy, inspections.length]);

    if (!isActiveRegistered && activePersona !== 'owner') {
        return (
            <div className={s.page}>
                <div className={s.gateCard}>
                    <div className={s.gateIcon}>◎</div>
                    <div className={s.gateTitle}>Register before sending</div>
                    <p className={s.gateBody}>
                        You need to register an encrypted audit key before you can hold or transfer VEIL.
                    </p>
                    <a href="/register" className={s.gateCta}>Register now →</a>
                </div>
            </div>
        );
    }

    const lastDetail = log.at(-1)?.msg;

    return (
        <div className={s.page}>
            <div className={s.pageHeader}>
                <h1 className={s.pageTitle}>Send VEIL</h1>
                <span className={s.pageSubtitle}>private transfer · sender stays hidden</span>
            </div>

            <div className={s.layout}>
                <div className={s.formCol}>
                    <Card>
                        <CardHeader>
                            <span className={s.cardTitle}>Transfer details</span>
                        </CardHeader>
                        <CardBody>
                            <div className={s.recipientRow}>
                                <div className={s.recipientLabel}>To</div>
                                <div className={s.recipientValue}>
                                    {toName}
                                    {setup && (
                                        <HashBadge
                                            value={sender === 'alice' ? setup.bob : setup.alice}
                                            head={8} tail={6}
                                            className={s.recipientHash}
                                        />
                                    )}
                                </div>
                            </div>

                            <div className={s.divider} />

                            <AmountInput
                                value={amount}
                                onChange={setAmount}
                                balance={activeBalance}
                                label="Amount"
                                disabled={busy}
                            />

                            {needsProof && (
                                <div className={s.proofIdField}>
                                    <label className={s.fieldLabel}>
                                        Deposit ID for ZK inclusion proof
                                    </label>
                                    <input
                                        className={s.proofIdInput}
                                        value={depositId}
                                        onChange={(e) => setDepositId(e.target.value)}
                                        placeholder="1"
                                        disabled={busy}
                                    />
                                    <div className={s.fieldHint}>
                                        Must be a deposit ID previously approved by the auditor.
                                    </div>
                                </div>
                            )}

                            <button
                                className={`${s.sendBtn} ${busy ? s.sendBtnBusy : ''}`}
                                onClick={() => transfer(sender, amount, depositId)}
                                disabled={busy || !amount || amountBig === 0n}
                            >
                                {busy ? (
                                    <>
                                        <span className={s.btnSpinner} />
                                        {needsProof ? 'Proving…' : 'Sending…'}
                                    </>
                                ) : `Send ${amount ? amountBig.toLocaleString() : '0'} VEIL → ${toName}`}
                            </button>
                        </CardBody>
                    </Card>

                    {/* ZK proof progress — only shown above threshold */}
                    {(needsProof || stage !== 'idle') && (
                        <ProofStatus stage={stage} detail={lastDetail} />
                    )}
                </div>

                {/* Info panel */}
                <div className={s.infoCol}>
                    <Card tone="shielded">
                        <CardHeader>
                            <span className={s.cardTitle}>Privacy guarantee</span>
                        </CardHeader>
                        <CardBody>
                            <ul className={s.privacyList}>
                                <li className={s.privacyItem}>
                                    <span className={s.privacyDot}>◈</span>
                                    Sender identity is never written to public state
                                </li>
                                <li className={s.privacyItem}>
                                    <span className={s.privacyDot}>◈</span>
                                    Recipient identity is never written to public state
                                </li>
                                <li className={s.privacyItem}>
                                    <span className={s.privacyDot}>◈</span>
                                    Transfer amount is never written to public state
                                </li>
                                <li className={s.privacyItem}>
                                    <span className={s.privacyDot}>◈</span>
                                    On-chain observer sees only note commitments and nullifiers
                                </li>
                            </ul>
                            {needsProof && (
                                <div className={s.proofNote}>
                                    Above {TRANSFER_THRESHOLD.toLocaleString()} VEIL, a ZK inclusion
                                    proof is required to demonstrate your deposit is on the auditor's
                                    approved list — without revealing which deposit it is.
                                </div>
                            )}
                        </CardBody>
                    </Card>
                </div>
            </div>
        </div>
    );
}
