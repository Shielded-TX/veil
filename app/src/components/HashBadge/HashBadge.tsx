import { useState, useCallback } from 'react';
import { formatHash } from '../../lib/format';
import s from './HashBadge.module.css';

interface HashBadgeProps {
    value: string | { toString(): string } | null | undefined;
    head?: number;
    tail?: number;
    label?: string;
    className?: string;
}

export function HashBadge({ value, head = 10, tail = 6, label, className = '' }: HashBadgeProps) {
    const [copied, setCopied] = useState(false);

    const str = value ? (typeof value === 'string' ? value : value.toString()) : null;

    const copy = useCallback(async () => {
        if (!str) return;
        try {
            await navigator.clipboard.writeText(str);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard API not available
        }
    }, [str]);

    if (!str) return <span className={`${s.badge} ${s.empty} ${className}`}>—</span>;

    return (
        <button
            className={`${s.badge} ${copied ? s.copied : ''} ${className}`}
            onClick={copy}
            title={str}
            type="button"
        >
            {label && <span className={s.label}>{label}</span>}
            <span className={s.hash}>{formatHash(str, head, tail)}</span>
            <span className={s.icon}>{copied ? '✓' : '⎘'}</span>
        </button>
    );
}
