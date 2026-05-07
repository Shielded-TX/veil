import s from './scaffold.module.css';

export function Deposit() {
    return (
        <div className={s.page}>
            <div className={s.pageHeader}>
                <h1 className={s.pageTitle}>Deposit</h1>
                <span className={s.pageSubtitle}>L1 → shielded VEIL</span>
            </div>
            <div className={s.scaffoldNote}>
                Three-step bridge flow (approve USDC → deposit on L1 → claim on L2).
                Requires viem + Sepolia RPC. UI scaffold + bridge call stub coming in Step 5.
            </div>
        </div>
    );
}
