import type { ReactNode } from 'react';
import s from './EmptyState.module.css';

interface EmptyStateProps {
    icon?: string;
    title: string;
    body?: string;
    cta?: ReactNode;
}

export function EmptyState({ icon = '◎', title, body, cta }: EmptyStateProps) {
    return (
        <div className={s.root}>
            <div className={s.icon}>{icon}</div>
            <div className={s.title}>{title}</div>
            {body && <div className={s.body}>{body}</div>}
            {cta && <div className={s.cta}>{cta}</div>}
        </div>
    );
}
