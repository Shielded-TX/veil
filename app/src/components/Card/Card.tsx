import type { ReactNode, CSSProperties } from 'react';
import s from './Card.module.css';

export type CardTone = 'default' | 'shielded' | 'audit' | 'exposed' | 'zk';

interface CardProps {
    tone?: CardTone;
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
    padding?: 'default' | 'none';
}

const STRIPE: Record<CardTone, string> = {
    default:  'transparent',
    shielded: 'var(--accent)',
    audit:    'var(--audit)',
    exposed:  'var(--exposed)',
    zk:       'var(--zk)',
};

export function Card({ tone = 'default', children, className = '', style, padding = 'default' }: CardProps) {
    return (
        <div
            className={`${s.card} ${padding === 'none' ? s.noPadding : ''} ${className}`}
            style={{ '--stripe-color': STRIPE[tone], ...style } as CSSProperties}
        >
            {children}
        </div>
    );
}

export function CardHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <div className={`${s.header} ${className}`}>{children}</div>;
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <div className={`${s.body} ${className}`}>{children}</div>;
}

export function CardSection({ label, children }: { label?: string; children: ReactNode }) {
    return (
        <div className={s.section}>
            {label && <div className={s.sectionLabel}>{label}</div>}
            {children}
        </div>
    );
}
