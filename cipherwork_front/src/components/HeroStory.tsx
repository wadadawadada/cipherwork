import { useEffect, useRef, useState } from 'react';
import { Stage, useDemoLoop, type StageInfo } from './Stage';

/** One short, plain sentence per step. The callout floats next to whoever the step is about. */
const COPY: Record<number, { title: string; text: string }> = {
  1: { title: 'Ask for a price', text: 'The marketplace only sees public details.' },
  2: { title: 'Lock the payment', text: 'The payment is locked in a NEAR escrow contract until a verdict arrives or the order times out.' },
  3: { title: 'Verify the vault', text: 'Each verified hardware property lights one lamp.' },
  4: { title: 'Send the secret', text: 'Encrypted, straight to the vault. The marketplace is blind to it.' },
  5: { title: 'Check the answer', text: 'A signed answer comes back. Only the agent can read it.' },
  6: { title: 'Pay on proof', text: 'The proof checker verifies public evidence and signs a verdict to release escrow.' },
};
const INSIDE = { title: 'Private inside the vault', text: 'Only the verified vault can read the secret. From outside, nobody sees it.' };
const DENIED = { title: 'Bad proof? The door stays shut', text: 'The secret is never sent and the provider is not paid. The escrow goes back to the buyer.' };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function HeroStory() {
  const [fail, setFail] = useState(false);
  const [replay, setReplay] = useState(0);
  const manual = useRef(false); // once the visitor touches the switch, stop flipping it for them
  const pick = (v: boolean) => { manual.current = true; setFail(v); };
  return <div className="hero-story"><Story key={`${fail}-${replay}`} fail={fail} setFail={pick} autoFlip={() => { if (!manual.current) setFail(!fail); }} onReplay={() => { manual.current = true; setReplay((x) => x + 1); }} /></div>;
}

type Spring = { x: number; y: number; vx: number; vy: number };

function Story({ fail, setFail, onReplay, autoFlip }: { fail: boolean; setFail: (v: boolean) => void; onReplay: () => void; autoFlip: () => void }) {
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const demo = useDemoLoop(fail, paused);
  const [info, setInfo] = useState<StageInfo>({ no: 0, caption: '', nPass: 0, failed: false });
  const active = Math.max(1, info.no);
  const rejected = info.failed;
  const finished = demo.steps.settle === 'done';
  const copy = rejected ? DENIED : active === 4 && info.caption.startsWith('Only inside') ? INSIDE : COPY[active];
  // after the first run ends, the switch flips by itself to show the other scenario
  useEffect(() => { if (!finished) return; const id = window.setTimeout(autoFlip, 3200); return () => clearTimeout(id); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const anchors = useRef<any>(null);
  const world = useRef<HTMLDivElement>(null);
  const callout = useRef<HTMLDivElement>(null);
  const label = { checker: useRef<HTMLDivElement>(null), market: useRef<HTMLDivElement>(null), buyer: useRef<HTMLDivElement>(null), escrow: useRef<HTMLDivElement>(null), provider: useRef<HTMLDivElement>(null), vault: useRef<HTMLDivElement>(null) };
  const inside = active === 4 && info.caption.startsWith('Only inside');
  const live = useRef({ active, rejected, inside });
  live.current = { active, rejected, inside };

  // Everything that annotates the scene is a small spring that chases a live anchor (a blob, the jar, the door).
  // So the callout glides from character to character, sways with their motion, and its tail keeps pointing at them.
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const st = new Map<string, Spring>();
    let raf = 0, t = 0, lastJar = 0;
    const follow = (id: string, tx: number, ty: number, k: number, damp: number): Spring => {
      let s = st.get(id);
      if (!s || reduce) { s = { x: tx, y: ty, vx: 0, vy: 0 }; st.set(id, s); return s; }
      s.vx = (s.vx + (tx - s.x) * k) * damp; s.vy = (s.vy + (ty - s.y) * k) * damp; s.x += s.vx; s.y += s.vy;
      return s;
    };
    const place = (el: HTMLElement | null, s: Spring, tilt: number) => { if (el) el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, 0) rotate(${tilt}deg)`; };

    const loop = () => {
      raf = requestAnimationFrame(loop); t++;
      const A = anchors.current, wd = world.current;
      if (!A || !wd) return;
      const mobile = window.innerWidth <= 760;
      const sc = wd.clientWidth / A.W, floorY = (A.floor + 26) * sc;

      // character labels travel with their characters; the escrow label flinches when a coin lands in the jar
      const lab = (id: keyof typeof label, tx: number, ty: number, k = 0.14, d = 0.74) => {
        const el = label[id].current; if (!el) return;
        if (mobile) { el.style.transform = ''; return; }
        const w = el.offsetWidth, s = follow(id, clamp(tx, w / 2 + 4, wd.clientWidth - w / 2 - 4), ty, k, d);
        place(el, s, clamp(s.vx * 1.1, -6, 6));
      };
      lab('buyer', A.hero.x * sc, floorY);
      // the agent's label yields to the escrow / provider labels instead of printing over them
      if (label.buyer.current && !mobile) { const d = Math.min(Math.abs(A.hero.x - A.jar.x), Math.abs(A.hero.x - A.provider.x)) * sc; label.buyer.current.style.opacity = String(clamp((d - 92) / 56, 0, 1)); }
      lab('provider', A.provider.x * sc, floorY);
      lab('market', A.market.x * sc, floorY);
      lab('checker', A.router.x * sc, 8 * sc + Math.sin(t / 50) * 1.5);
      lab('vault', A.vault.x * sc, (A.vault.y - 82) * sc);
      if (A.jarCoins > lastJar) { const s = st.get('escrow'); if (s) s.vy += 4.5; }
      lastJar = A.jarCoins;
      lab('escrow', A.jar.x * sc, (A.jar.y - 46) * sc, 0.16, 0.7);

      // the callout: a balloon on a spring
      const el = callout.current; if (!el) return;
      if (mobile) { el.style.transform = ''; el.style.removeProperty('--tail'); return; }
      const { active: a, rejected: rej, inside: ins } = live.current;
      let anchor = A.hero, below = false;
      if (rej) anchor = A.forger ?? { ...A.door, r: 0 };
      else if (a === 1) anchor = A.market;
      else if (a === 2) { anchor = { x: A.jar.x, y: A.jar.y + 78, r: 0 }; below = true; }
      else if (a === 3) anchor = A.inspector;
      else if (a === 6) { anchor = A.router; below = true; }
      if (ins && !rej) anchor = { x: A.door.x - 105, y: A.door.y - 10, r: 0 }; // keep the veiled vault in plain view
      const w = el.offsetWidth, h = el.offsetHeight, ax = anchor.x * sc;
      const gap = 22 * sc + 10;
      const ty = below ? anchor.y * sc + gap : (anchor.y - anchor.r) * sc - gap - h;
      const tx = clamp(ax, w / 2 + 6, wd.clientWidth - w / 2 - 6);
      const s = follow('callout', tx, clamp(ty, 6, wd.clientHeight - h - 6), 0.085, 0.78);
      const tilt = clamp(s.vx * 1.7 + Math.sin(t / 32) * 0.9, -10, 10);
      el.style.transformOrigin = below ? '50% 0%' : '50% 100%';
      el.classList.toggle('tail-up', below); el.classList.toggle('tail-down', !below);
      el.style.setProperty('--tail', `${clamp(ax - (s.x - w / 2), 22, w - 22)}px`);
      place(el, s, tilt);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={`story-world ${rejected ? 'is-rejected' : ''}`} ref={world}>
      <Stage steps={demo.steps} checks={demo.checks} outcome={demo.outcome} hideCaption sharedFloor onInfo={setInfo} paused={paused} anchorsRef={anchors} />

      <div ref={label.checker} className={`scene-label proof-checker ${active >= 5 || rejected ? 'lit' : ''}`}><b>Proof checker</b><small>Public evidence only</small></div>
      <div ref={label.market} className={`scene-label marketplace ${active === 1 ? 'lit' : ''}`}><b>Marketplace</b><small>Public details only</small></div>
      <div ref={label.buyer} className={`scene-label buyer ${rejected ? 'denied' : ''}`}><b>Your agent</b><small>{rejected ? 'Secret never sent' : demo.steps.execute === 'done' ? 'Answer received' : active === 4 ? 'Sending encrypted data' : 'Holds your secret'}</small></div>
      <div ref={label.escrow} className={`scene-label escrow ${active === 2 || active === 6 ? 'lit' : ''}`}><b>NEAR escrow</b><small>{finished ? (rejected ? 'Refunded' : 'Payment released') : (demo.steps.fund === 'done' ? 'Payment held' : 'Holds the payment')}</small></div>
      <div ref={label.provider} className={`scene-label provider ${active === 6 && !rejected ? 'lit' : ''}`}><b>Provider</b><small>{finished && !rejected ? 'Paid' : 'Gets paid on proof'}</small></div>
      <div ref={label.vault} className={`scene-label vault ${active >= 3 ? (rejected ? 'denied' : 'lit') : ''}`}><b>Secure vault · TEE</b><small>{rejected ? 'Locked · invalid proof' : demo.steps.preflight === 'done' ? 'Verified hardware' : 'Verify before entry'}</small></div>

      <div ref={callout} className={`callout tail-down ${rejected ? 'denied' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        <div key={rejected ? 'x' : active} className="callout-body">
          <div className="callout-top"><span>{rejected ? '!' : active}</span>{rejected ? 'Rejected' : `Step ${active} of 6`}</div>
          <b>{copy.title}</b>
          <p>{copy.text}</p>
        </div>
      </div>

      <div className={`wall-switch ${fail ? 'is-forged' : ''}`}>
        <div className="plate">
          <i className="screw a" /><i className="screw b" /><i className="screw c" /><i className="screw d" />
          <i className="ws-led" aria-hidden />
          <button className="ws-label top" aria-pressed={!fail} onClick={() => (fail ? setFail(false) : onReplay())}>Happy</button>
          <button className="ws-rocker" role="switch" aria-checked={fail} aria-label="Forged proof scenario" onClick={() => setFail(!fail)}><span className="ws-thumb" /></button>
          <button className="ws-label bottom" aria-pressed={fail} onClick={() => (fail ? onReplay() : setFail(true))}>Forged</button>
        </div>
      </div>
    </div>
  );
}
