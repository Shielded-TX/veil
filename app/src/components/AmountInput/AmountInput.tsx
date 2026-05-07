import { useId } from 'react';
import { TRANSFER_THRESHOLD } from '../../hooks/useVeil';
import s from './AmountInput.module.css';

interface AmountInputProps {
    value: string;
    onChange: (v: string) => void;
    balance?: bigint | null;
    label?: string;
    disabled?: boolean;
}

export function AmountInput({ value, onChange, balance, label = 'Amount', disabled }: AmountInputProps) {
    const id = useId();

    const parsed = (() => { try { return value ? BigInt(value) : 0n; } catch { return null; } })();
    const isValid   = parsed !== null;
    const hasMax    = balance !== null && balance !== undefined && balance > 0n;
    const overMax   = isValid && parsed !== null && hasMax && parsed > balance!;
    const needsProof = isValid && parsed !== null && parsed > TRANSFER_THRESHOLD;

    return (
        <div className={s.root}>
            <div className={s.labelRow}>
                <label className={s.label} htmlFor={id}>{label}</label>
                {balance !== null && balance !== undefined && (
                    <span className={s.balanceHint}>
                        Balance: {balance.toLocaleString()} VEIL
                    </span>
                )}
            </div>

            <div className={`${s.inputWrap} ${overMax ? s.error : ''} ${!isValid && value ? s.error : ''}`}>
                <input
                    id={id}
                    className={s.input}
                    type="text"
                    inputMode="numeric"
                    value={value}
                    onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="0"
                    disabled={disabled}
                    autoComplete="off"
                />
                <span className={s.unit}>VEIL</span>
                {hasMax && (
                    <button
                        type="button"
                        className={s.maxBtn}
                        onClick={() => onChange(balance!.toString())}
                        disabled={disabled}
                        tabIndex={-1}
                    >
                        max
                    </button>
                )}
            </div>

            {overMax && (
                <div className={s.hint} data-tone="error">
                    Exceeds balance of {balance!.toLocaleString()} VEIL
                </div>
            )}

            {needsProof && !overMax && (
                <div className={s.hint} data-tone="zk">
                    ◈ Above {TRANSFER_THRESHOLD.toLocaleString()} VEIL threshold — ZK proof required
                </div>
            )}

            {!needsProof && isValid && parsed! > 0n && !overMax && (
                <div className={s.hint} data-tone="ok">
                    Below threshold — no proof required
                </div>
            )}
        </div>
    );
}
