/** Truncate a hash/address: `0x1234…abcd` */
export function formatHash(
    s: string | { toString(): string },
    head = 10,
    tail = 6,
): string {
    const str = typeof s === 'string' ? s : s.toString();
    if (str.length <= head + tail + 1) return str;
    return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

/** Thousands-separated VEIL amount */
export function formatAmount(n: bigint | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString('en-US');
}

/** Format a hex string that may be a decimal number */
export function formatHexOrDec(s: string): string {
    if (!s.startsWith('0x') && /^\d+$/.test(s)) {
        try {
            const hex = BigInt(s).toString(16).padStart(64, '0');
            return formatHash(`0x${hex}`, 10, 6);
        } catch { return s; }
    }
    return formatHash(s, 10, 6);
}

/** `hh:mm:ss` → already that format from toLocaleTimeString, kept for consistency */
export function formatTime(ts: string): string {
    return ts;
}
