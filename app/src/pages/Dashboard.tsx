import { Link } from 'react-router-dom';
import { useVeilContext } from '../context/VeilContext';
import { Card, CardBody, CardHeader, CardSection } from '../components/Card/Card';
import { HashBadge } from '../components/HashBadge/HashBadge';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { formatAmount } from '../lib/format';
import s from './Dashboard.module.css';

export function Dashboard() {
    const {
        activePersona, activeBalance, activeAddress,
        isActiveRegistered, isAuditor,
        aliceBalance, bobBalance,
        inspections, log,
    } = useVeilContext();

    const personaName = activePersona === 'owner' ? 'Owner / Auditor'
        : activePersona === 'alice' ? 'Alice' : 'Bob';

    const recentTx = inspections.slice(-5).reverse();
    const recentLog = log.slice(-4).reverse();

    return (
        <div className={s.page}>

            {/* ── Hero balance ── */}
            <div className={s.hero}>
                <div className={s.heroLeft}>
                    <div
                        className={s.heroAvatar}
                        style={{ background: `var(--c-${activePersona})` }}
                    >
                        {personaName[0]}
                    </div>
                    <div>
                        <div className={s.heroName}>{personaName}</div>
                        {activeAddress && (
                            <HashBadge value={activeAddress} head={8} tail={6} className={s.heroAddr} />
                        )}
                    </div>
                </div>

                {!isActiveRegistered && activePersona !== 'owner' && (
                    <Link to="/register" className={s.regBadge}>
                        ⚠ Register for audit →
                    </Link>
                )}

                {isAuditor && (
                    <Link to="/auditor" className={s.auditorBadge}>
                        ⚑ Auditor portal →
                    </Link>
                )}
            </div>

            {activePersona !== 'owner' && (
                <div className={s.balanceCard}>
                    <div className={s.balanceLabel}>Private balance</div>
                    <div className={s.balanceNum}>
                        {formatAmount(activeBalance)}
                        <span className={s.balanceUnit}>VEIL</span>
                    </div>
                    <div className={s.balanceNote}>
                        Only visible to you via your decryption key
                    </div>
                </div>
            )}

            {/* ── CTAs ── */}
            {activePersona !== 'owner' && isActiveRegistered && (
                <div className={s.ctaRow}>
                    <Link to="/send" className={`${s.cta} ${s.ctaPrimary}`}>
                        <span className={s.ctaIcon}>↑</span>
                        Send VEIL
                    </Link>
                    <Link to="/withdraw" className={s.cta}>
                        <span className={s.ctaIcon}>⇥</span>
                        Withdraw
                    </Link>
                    <Link to="/deposit" className={s.cta}>
                        <span className={s.ctaIcon}>↓</span>
                        Deposit
                    </Link>
                </div>
            )}

            <div className={s.grid}>
                {/* ── Recent activity ── */}
                <Card>
                    <CardHeader>
                        <span className={s.sectionTitle}>Recent transfers</span>
                        {recentTx.length > 0 && (
                            <Link to="/inspect" className={s.sectionLink}>
                                View inspector →
                            </Link>
                        )}
                    </CardHeader>
                    <CardBody>
                        {recentTx.length === 0 ? (
                            <EmptyState
                                icon="↑"
                                title="No transfers yet"
                                body="Send VEIL to see privacy-verified transactions here."
                            />
                        ) : (
                            <div className={s.txList}>
                                {recentTx.map((tx, i) => {
                                    const leaked = tx.senderFound || tx.recipientFound || tx.amountFound;
                                    return (
                                        <Link to="/inspect" key={i} className={s.txRow}>
                                            <span className={s.txDir}>↑</span>
                                            <div className={s.txMain}>
                                                <span className={s.txAmount}>
                                                    {formatAmount(tx.amount)} VEIL
                                                </span>
                                                <HashBadge value={tx.txHash} head={6} tail={4} />
                                            </div>
                                            <span className={`${s.txBadge} ${leaked ? s.txBadgeLeak : ''}`}>
                                                {leaked ? '⚠ leak' : '◈ shielded'}
                                            </span>
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </CardBody>
                </Card>

                {/* ── Activity log ── */}
                <Card>
                    <CardHeader>
                        <span className={s.sectionTitle}>Activity</span>
                        {log.length > 0 && (
                            <span className={s.logCount}>{log.length}</span>
                        )}
                    </CardHeader>
                    <CardBody>
                        {recentLog.length === 0 ? (
                            <EmptyState icon="◈" title="No activity yet" />
                        ) : (
                            <div className={s.logList}>
                                {recentLog.map((e, i) => (
                                    <div key={i} className={`${s.logRow} ${s[`log_${e.level}`]}`}>
                                        <span className={s.logTs}>{e.time}</span>
                                        <span className={s.logMsg}>{e.msg}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardBody>
                </Card>

                {/* ── Balances overview (owner sees both) ── */}
                {activePersona === 'owner' && (
                    <Card tone="audit">
                        <CardHeader>
                            <span className={s.sectionTitle}>Account balances</span>
                        </CardHeader>
                        <CardBody>
                            <CardSection label="Alice">
                                <div className={s.balanceLine}>
                                    <span className={s.balanceLineNum}>{formatAmount(aliceBalance)}</span>
                                    <span className={s.balanceLineUnit}>VEIL</span>
                                </div>
                            </CardSection>
                            <CardSection label="Bob">
                                <div className={s.balanceLine}>
                                    <span className={s.balanceLineNum}>{formatAmount(bobBalance)}</span>
                                    <span className={s.balanceLineUnit}>VEIL</span>
                                </div>
                            </CardSection>
                            <div className={s.ownerNote}>
                                Balances are readable because you hold the auditor role.
                                Regular observers see nothing.
                            </div>
                        </CardBody>
                    </Card>
                )}
            </div>
        </div>
    );
}
