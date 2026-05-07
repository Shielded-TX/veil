import { useVeilContext } from '../context/VeilContext';
import s from './scaffold.module.css';
import r from './Register.module.css';

export function Register() {
    const {
        activePersona, isActiveRegistered, register, busy, log,
    } = useVeilContext();

    const who = activePersona === 'bob' ? 'bob' : 'alice';
    const isOwner = activePersona === 'owner';

    // Most recent log entry — shown while proving
    const lastLog = log.at(-1);

    return (
        <div className={s.page}>
            <div className={s.pageHeader}>
                <h1 className={s.pageTitle}>Register for audit</h1>
            </div>

            <div className={r.card}>
                <div className={r.icon}>◎</div>
                <h2 className={r.cardTitle}>
                    {isActiveRegistered ? 'Already registered' : 'One-time setup required'}
                </h2>
                <p className={r.cardBody}>
                    To hold or transfer VEIL you must register an encrypted audit key. The key
                    is stored on-chain encrypted to the auditor's public key — the auditor cannot
                    read your history unless they formally request access and the event is
                    publicly visible on-chain.
                </p>

                {isActiveRegistered ? (
                    <div className={r.status}>
                        <span className={r.statusDot} style={{ background: 'var(--accent)' }} />
                        Registered — audit key on-chain
                    </div>
                ) : isOwner ? (
                    <div className={r.status}>
                        <span className={r.statusDot} style={{ background: 'var(--c-owner)' }} />
                        Owner / Auditor is always registered
                    </div>
                ) : (
                    <>
                        <button
                            className={r.cta}
                            onClick={() => register(who)}
                            disabled={busy}
                        >
                            {busy ? (
                                <span className={r.ctaBusy}>
                                    <span className={r.spinner} />
                                    Generating proof…
                                </span>
                            ) : (
                                `Register ${who === 'alice' ? 'Alice' : 'Bob'}`
                            )}
                        </button>

                        {busy && lastLog && (
                            <div className={r.proving}>
                                <span className={r.provingIcon}>◈</span>
                                {lastLog.msg}
                            </div>
                        )}

                        <p className={r.hint}>
                            This submits one transaction. Aztec generates a ZK proof locally
                            in your browser — this takes 20–60 s on first run while the
                            prover WASM initialises.
                        </p>
                    </>
                )}
            </div>

            {isActiveRegistered && (
                <div className={r.rotateCard}>
                    <div className={r.rotateTitle}>Rotate audit key</div>
                    <p className={r.cardBody} style={{ marginBottom: 12 }}>
                        Calling <code>rotate_audit_key</code> replaces your on-chain key. A future
                        audit can only decrypt the period covered by the most recently registered key.
                    </p>
                    <button
                        className={r.rotateBtn}
                        onClick={() => register(who)}
                        disabled={busy || isOwner}
                    >
                        Rotate key
                    </button>
                </div>
            )}
        </div>
    );
}
