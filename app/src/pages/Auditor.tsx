import { useVeilContext } from '../context/VeilContext';
import s from './scaffold.module.css';

export function Auditor() {
    const {
        isAuditor, busy,
        mint, mintAmount, setMintAmount,
        approveDeposit, approveDepositId, setApproveDepositId,
        requestAudit, auditReason, setAuditReason,
        aliceRegistered, bobRegistered,
    } = useVeilContext();

    if (!isAuditor) {
        return (
            <div className={s.page}>
                <div className={s.notConnected}>
                    <p>403 — This page is only accessible to the Owner / Auditor persona.</p>
                    <p style={{ marginTop: 8, fontSize: 12 }}>Switch to Owner / Auditor in the sidebar.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={s.page}>
            <div className={s.pageHeader}>
                <h1 className={s.pageTitle}>Auditor portal</h1>
                <span className={s.pageSubtitle}>owner · auditor</span>
            </div>

            <div className={s.scaffoldNote} style={{ marginBottom: 20 }}>
                Full auditor portal with audit history, threshold controls, and bad-list root
                management coming in Step 5. Core actions are wired below.
            </div>

            {/* Mint */}
            <section style={{ marginBottom: 20 }}>
                <div className={s.heroLabel} style={{ marginBottom: 8 }}>Mint VEIL</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                        style={{ padding: '7px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-med)', borderRadius: 'var(--r-sm)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 13, width: 100 }}
                        value={mintAmount}
                        onChange={(e) => setMintAmount(e.target.value)}
                    />
                    <button style={btnStyle} onClick={() => mint('alice', mintAmount)} disabled={busy}>→ Alice</button>
                    <button style={btnStyle} onClick={() => mint('bob', mintAmount)}   disabled={busy}>→ Bob</button>
                </div>
            </section>

            {/* Approve deposit */}
            <section style={{ marginBottom: 20 }}>
                <div className={s.heroLabel} style={{ marginBottom: 8 }}>Approve deposit ID</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                        style={{ padding: '7px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-med)', borderRadius: 'var(--r-sm)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 13, width: 100 }}
                        value={approveDepositId}
                        onChange={(e) => setApproveDepositId(e.target.value)}
                    />
                    <button style={btnStyle} onClick={() => approveDeposit(approveDepositId)} disabled={busy}>
                        Publish root
                    </button>
                </div>
            </section>

            {/* Request audit */}
            <section>
                <div className={s.heroLabel} style={{ marginBottom: 8 }}>Request audit</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                        style={{ padding: '7px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-med)', borderRadius: 'var(--r-sm)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 13, flex: 1, minWidth: 200 }}
                        value={auditReason}
                        onChange={(e) => setAuditReason(e.target.value)}
                        placeholder="Reason / case number"
                    />
                    <button style={btnStyle} onClick={() => requestAudit('alice', auditReason)} disabled={busy || !aliceRegistered}>Audit Alice</button>
                    <button style={btnStyle} onClick={() => requestAudit('bob', auditReason)}   disabled={busy || !bobRegistered}>Audit Bob</button>
                </div>
            </section>
        </div>
    );
}

const btnStyle: React.CSSProperties = {
    padding: '7px 14px',
    background: 'var(--surface-3)',
    color: 'var(--text-1)',
    border: '1px solid var(--border-med)',
    borderRadius: 'var(--r-sm)',
    fontFamily: 'var(--font-sans)',
    fontSize: 12.5,
    cursor: 'pointer',
};
