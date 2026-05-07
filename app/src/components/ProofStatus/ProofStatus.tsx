import s from './ProofStatus.module.css';

export type ProofStage = 'idle' | 'building' | 'proving' | 'submitting' | 'done' | 'error';

interface ProofStatusProps {
    stage: ProofStage;
    /** Latest log message to surface (e.g. "leaf_index=3, 8 siblings") */
    detail?: string;
}

const STAGES: { id: ProofStage; label: string }[] = [
    { id: 'building',   label: 'Building witnesses' },
    { id: 'proving',    label: 'Generating proof'   },
    { id: 'submitting', label: 'Submitting tx'      },
];

const STAGE_ORDER: ProofStage[] = ['idle', 'building', 'proving', 'submitting', 'done', 'error'];

function stageIndex(s: ProofStage) { return STAGE_ORDER.indexOf(s); }

export function ProofStatus({ stage, detail }: ProofStatusProps) {
    if (stage === 'idle' || stage === 'done') return null;

    const isError = stage === 'error';

    return (
        <div className={`${s.root} ${isError ? s.rootError : ''}`}>
            <div className={s.header}>
                <span className={`${s.orb} ${isError ? s.orbError : s.orbActive}`} />
                <span className={s.title}>
                    {isError ? 'Proof failed' : 'Generating ZK proof'}
                </span>
                {!isError && <span className={s.tagZk}>UltraPlonk · Barretenberg</span>}
            </div>

            {!isError && (
                <div className={s.steps}>
                    {STAGES.map((step) => {
                        const current  = stageIndex(stage);
                        const stepIdx  = stageIndex(step.id);
                        const isDone   = current > stepIdx;
                        const isActive = current === stepIdx;

                        return (
                            <div key={step.id} className={`${s.step} ${isDone ? s.stepDone : ''} ${isActive ? s.stepActive : ''}`}>
                                <span className={s.stepDot}>
                                    {isDone ? '✓' : isActive ? <span className={s.spinner} /> : '·'}
                                </span>
                                <span className={s.stepLabel}>{step.label}</span>
                                {isActive && <span className={s.stepActive_tag}>active</span>}
                            </div>
                        );
                    })}
                </div>
            )}

            {detail && (
                <div className={s.detail}>{detail}</div>
            )}

            {!isError && (
                <div className={s.footer}>
                    Proof runs locally in your browser. Keep this tab in the foreground.
                    First run takes ~60 s while the WASM prover initialises.
                </div>
            )}
        </div>
    );
}
