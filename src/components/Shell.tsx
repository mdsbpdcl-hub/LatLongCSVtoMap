import { useEffect, type ReactNode } from 'react';
import { STEPS } from '../state';

export function Logo() {
  return (
    <div className="logo" aria-hidden>
      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2.5c-4.1 0-7.4 3.2-7.4 7.2 0 5.4 7.4 12.3 7.4 12.3s7.4-6.9 7.4-12.3c0-4-3.3-7.2-7.4-7.2zm0 9.9a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4z" fill="#173a25" /></svg>
    </div>
  );
}

export function Header({ onReset, onSettings }: { onReset: () => void; onSettings: () => void }) {
  return (
    <header className="header">
      <Logo />
      <div>
        <div className="app-name">CSV Map</div>
      </div>
      <div className="app-sub">Map, filter and export large CSV files</div>
      <div className="spacer" />
      <span className="privacy" title="CSV files are read and processed inside this browser tab. They are never uploaded. Only background map tiles are downloaded from the map provider.">
        🔒 <span className="long">Files stay on this computer</span>
      </span>
      <button className="icon-btn" title="Storage & privacy settings" onClick={onSettings} aria-label="Settings">⚙</button>
      <button className="btn small" onClick={onReset} title="Clear all data and start again">Reset</button>
    </header>
  );
}

export function Stepper({ step, maxReachable, onGo }: { step: number; maxReachable: number; onGo: (i: number) => void }) {
  return (
    <nav className="stepper" aria-label="Steps">
      {STEPS.map((s, i) => (
        <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
          {i > 0 && <div className={`step-line ${i <= step ? 'done' : ''}`} />}
          <button
            className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
            disabled={i > maxReachable}
            onClick={() => onGo(i)}
            aria-current={i === step ? 'step' : undefined}
          >
            <span className="dot">{i < step ? '✓' : i + 1}</span>
            <span className="label">{s}</span>
          </button>
        </div>
      ))}
    </nav>
  );
}

export function BottomBar({ step, canNext, info, onBack, onNext, nextLabel }: {
  step: number; canNext: boolean; info: ReactNode; onBack: () => void; onNext: () => void; nextLabel?: string;
}) {
  return (
    <div className="bottombar">
      <button className="btn" onClick={onBack} disabled={step === 0}>← Back</button>
      <div className="info">{info}</div>
      {step < STEPS.length - 1 && (
        <button className="btn primary" onClick={onNext} disabled={!canNext}>{nextLabel || 'Next'} →</button>
      )}
    </div>
  );
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        {footer && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [text, onDone]);
  return <div className="toast" role="status">{text}</div>;
}

export function Progress({ value }: { value: number }) {
  return <div className="progress"><div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} role="radio" aria-checked={o.value === value}>{o.label}</button>
      ))}
    </div>
  );
}
