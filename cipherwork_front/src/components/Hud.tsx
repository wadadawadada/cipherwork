import { STEP_LIST, type StepMap } from './Stage';

export const CHECK_NAMES = ['Fresh nonce', 'Hardware quote (Intel TDX)', 'Signing key bound', 'Boot log replay', 'Config hash', 'GPU evidence (NVIDIA)'];

/** The six hardware checks light up one by one while the buyer verifies the vault. */
export function Checklist({ nPass, failed, className = '' }: { nPass: number; failed: boolean; className?: string }) {
  return (
    <div className={`glass ${className}`} aria-label="Hardware proof checklist">
      <div className="label !text-[10.5px] !text-white/55 mb-1.5">Hardware proof checklist</div>
      {CHECK_NAMES.map((n, i) => {
        const bad = failed && i === nPass - 1;
        const on = i < nPass && !bad;
        return <div key={n} className={`chk-row ${bad ? 'bad' : on ? 'on' : ''}`}><i />{bad ? '✕ ' : on ? '✓ ' : ''}{n}</div>;
      })}
    </div>
  );
}

/** Current step of the job, with a plain-language sentence. */
export function StatusCard({ no, caption, steps, className = '', footer }: { no: number; caption: string; steps: StepMap; className?: string; footer?: React.ReactNode }) {
  const cur = STEP_LIST.find((s) => s.n === no);
  return (
    <div className={`glass ${className}`} aria-live="polite">
      <div className="flex items-center gap-2 text-[12px] mono font-bold text-white/60">
        <span className="w-5 h-5 rounded-full bg-[#7b61ff] text-white grid place-items-center text-[11px]">{no || '·'}</span>
        {no ? `STEP ${no} OF 6 · ${cur?.title.toUpperCase()}` : 'READY'}
      </div>
      <div className="hud-seg" aria-hidden>
        {STEP_LIST.map((s) => { const st = steps[s.key]; return <i key={s.n} className={st === 'done' ? 'done' : st === 'failed' ? 'bad' : st === 'active' ? 'on' : ''} />; })}
      </div>
      <p className="text-[14.5px] leading-snug text-white/90 min-h-[40px]">{caption}</p>
      {footer}
    </div>
  );
}
