import { useState } from 'react';
import { NavLink, Outlet, useNavigate, Navigate } from 'react-router-dom';
import { useVeilContext } from '../../context/VeilContext';
import { formatAmount, formatHash } from '../../lib/format';
import type { Persona } from '../../hooks/useVeil';
import s from './Shell.module.css';

const PERSONA_COLORS: Record<Persona, string> = {
    owner: 'var(--c-owner)',
    alice: 'var(--c-alice)',
    bob:   'var(--c-bob)',
};

const PERSONA_LABELS: Record<Persona, string> = {
    owner: 'Owner / Auditor',
    alice: 'Alice',
    bob:   'Bob',
};

const NAV_ITEMS = [
    { to: '/',          icon: '◈',  label: 'Dashboard'  },
    { to: '/send',      icon: '↑',  label: 'Send'       },
    { to: '/withdraw',  icon: '⇥',  label: 'Withdraw'   },
    { to: '/deposit',   icon: '↓',  label: 'Deposit'    },
    { to: '/register',  icon: '◎',  label: 'Register'   },
] as const;

export function Shell() {
    const {
        connected, busy, activePersona, setActivePersona,
        activeBalance, isAuditor, setup, log,
    } = useVeilContext();

    const navigate = useNavigate();
    const [logOpen, setLogOpen] = useState(true);

    function switchPersona(p: Persona) {
        setActivePersona(p);
        if (p !== 'owner') navigate('/');
    }

    if (!connected) return <Navigate to="/connect" replace />;

    const statusClass = busy ? s.working : connected ? s.connected : '';

    // Show the last 6 log entries, newest first
    const visibleLog = log.slice(-6).reverse();

    return (
        <div className={s.shell}>
            {/* ── Sidebar ── */}
            <aside className={s.sidebar}>
                <NavLink to="/" className={s.logo}>
                    <div className={s.logoMark}>V</div>
                    <span className={s.logoName}>veil</span>
                </NavLink>

                <nav className={s.nav}>
                    {NAV_ITEMS.map(({ to, icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            end={to === '/'}
                            className={({ isActive }) =>
                                `${s.navItem}${isActive ? ` ${s.active}` : ''}`
                            }
                        >
                            <span className={s.navIcon}>{icon}</span>
                            <span className={s.navLabel}>{label}</span>
                        </NavLink>
                    ))}

                    <div className={s.navDivider} />

                    <NavLink
                        to="/inspect"
                        className={({ isActive }) =>
                            `${s.navItem}${isActive ? ` ${s.active}` : ''}`
                        }
                    >
                        <span className={s.navIcon}>◎</span>
                        <span className={s.navLabel}>Inspector</span>
                    </NavLink>

                    {isAuditor && (
                        <NavLink
                            to="/auditor"
                            className={({ isActive }) =>
                                `${s.navItem}${isActive ? ` ${s.active}` : ''}`
                            }
                        >
                            <span className={s.navIcon}>⚑</span>
                            <span className={s.navLabel}>Auditor</span>
                            <span className={s.navBadge}>admin</span>
                        </NavLink>
                    )}
                </nav>

                {/* ── Persona switcher ── */}
                <div className={s.sidebarFooter}>
                    <div className={s.personaLabel}>Active persona</div>
                    {(['alice', 'bob', 'owner'] as Persona[]).map((p) => {
                        const addr = setup
                            ? p === 'alice' ? setup.alice
                            : p === 'bob'   ? setup.bob
                            : setup.owner
                            : null;
                        return (
                            <button
                                key={p}
                                className={`${s.personaOption}${activePersona === p ? ` ${s.personaActive}` : ''}`}
                                onClick={() => switchPersona(p)}
                            >
                                <span
                                    className={s.personaDot}
                                    style={{ background: PERSONA_COLORS[p] }}
                                />
                                {PERSONA_LABELS[p]}
                                {addr && (
                                    <span className={s.personaAddr}>
                                        {formatHash(addr, 4, 4)}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </aside>

            {/* ── Main ── */}
            <div className={s.main}>
                {/* Topbar */}
                <header className={s.topbar}>
                    {activeBalance !== null && (
                        <div className={s.topbarBalance}>
                            <span className={s.topbarBalanceLabel}>Balance</span>
                            {formatAmount(activeBalance)} VEIL
                        </div>
                    )}
                    <div className={`${s.topbarStatus} ${statusClass}`}>
                        <span className={s.topbarDot} />
                        {busy ? 'proving…' : connected ? 'devnet' : 'not connected'}
                    </div>
                </header>

                {/* Page content */}
                <main className={s.content}>
                    <Outlet />
                </main>

                {/* ── Activity strip ── */}
                <div className={s.activityStrip}>
                    <div
                        className={s.activityStripHeader}
                        onClick={() => setLogOpen((o) => !o)}
                    >
                        <span className={s.activityStripTitle}>
                            Activity {log.length > 0 && `(${log.length})`}
                        </span>
                        <span className={s.activityStripToggle}>{logOpen ? '▾' : '▸'}</span>
                    </div>
                    {logOpen && (
                        <div className={s.activityStripBody}>
                            {visibleLog.length === 0 ? (
                                <div className={s.activityStripEmpty}>
                                    Contract calls will appear here
                                </div>
                            ) : (
                                visibleLog.map((e, i) => (
                                    <div
                                        key={i}
                                        className={`${s.activityStripEntry} ${s[e.level] ?? ''}`}
                                    >
                                        <span className={s.activityStripTs}>{e.time}</span>
                                        {e.msg}
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
