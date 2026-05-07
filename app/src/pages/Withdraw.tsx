import s from './scaffold.module.css';

export function Withdraw() {
    return (
        <div className={s.page}>
            <div className={s.pageHeader}>
                <h1 className={s.pageTitle}>Withdraw</h1>
                <span className={s.pageSubtitle}>private → public</span>
            </div>
            <div className={s.scaffoldNote}>
                Withdraw VEIL to a public address. Sender stays private; amount and recipient
                become public via the Withdrawal event. Trade-off UI + form coming in Step 4.
            </div>
        </div>
    );
}
