import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useVeilContext } from '../context/VeilContext';
import type { Persona } from '../hooks/useVeil';
import s from './Connect.module.css';

const PERSONAS: { id: Persona; label: string; desc: string; color: string }[] = [
    {
        id:    'alice',
        label: 'Alice',
        desc:  'Private token holder. Sends and receives shielded VEIL.',
        color: 'var(--c-alice)',
    },
    {
        id:    'bob',
        label: 'Bob',
        desc:  "Second token holder. Use to see the recipient's view of a transfer.",
        color: 'var(--c-bob)',
    },
    {
        id:    'owner',
        label: 'Owner / Auditor',
        desc:  'Contract owner. Can mint, approve deposits, and request audits.',
        color: 'var(--c-owner)',
    },
];

export function Connect() {
    const { connect, busy, connected } = useVeilContext();
    const [selected, setSelected] = useState<Persona>('alice');

    // Once connected (state settled after re-render), redirect into the app.
    if (connected) return <Navigate to="/" replace />;

    return (
        <div className={s.page}>
            <div className={s.card}>
                <div className={s.logo}>
                    <div className={s.logoMark}>V</div>
                    <span className={s.logoName}>veil</span>
                </div>

                <h1 className={s.title}>Connect to devnet</h1>
                <p className={s.body}>
                    Choose which persona to connect as. You can switch personas at any time
                    from the sidebar without disconnecting.
                </p>

                <div className={s.prereq}>
                    <span className={s.prereqIcon}>$</span>
                    aztec start --local-network
                </div>

                <div className={s.personaGrid}>
                    {PERSONAS.map((p) => (
                        <button
                            key={p.id}
                            className={`${s.persona}${selected === p.id ? ` ${s.personaSelected}` : ''}`}
                            style={{ '--stripe': p.color } as React.CSSProperties}
                            onClick={() => setSelected(p.id)}
                        >
                            <span className={s.personaDot} style={{ background: p.color }} />
                            <div>
                                <div className={s.personaName}>{p.label}</div>
                                <div className={s.personaDesc}>{p.desc}</div>
                            </div>
                        </button>
                    ))}
                </div>

                <button
                    className={s.cta}
                    onClick={() => connect(selected)}
                    disabled={busy}
                >
                    {busy ? 'Connecting…' : `Connect as ${PERSONAS.find(p => p.id === selected)?.label}`}
                </button>
            </div>
        </div>
    );
}
