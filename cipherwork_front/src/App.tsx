import { LaneIcon, type LaneIconName } from './components/LaneIcon';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as sdk from '@nearai/inference-sdk';
import { api, API_URL } from './lib/api';
import { buildProofBundle, preflight, PreflightError, runPrivateInference, type FaultInjection, type Preflight, type PreflightCheck, type PrivateResult } from './lib/privateJob';
import { KeyPair } from 'near-api-js';
import { account, balanceYocto, contractView, EXPLORER, fmtNear, loadBurner, resetBurner } from './lib/wallet';
import { Stage, Stepper, useDemoLoop, type StageInfo } from './components/Stage';
import { Checklist, StatusCard } from './components/Hud';
import { HeroStory } from './components/HeroStory';
import { clearNet, installNetLog, netLog, subscribeNet } from './lib/netlog';

installNetLog();
const NEAR_AI = 'https://cloud-api.near.ai/v1';
const GPU_RELAY = { nrasUrl: `${API_URL}/v1/relay/nras`, jwksUrl: `${API_URL}/v1/relay/nras-jwks` };

const SAMPLE = `NORTHWIND HARBOR LOGISTICS (FICTIONAL COMPANY, SYNTHETIC DATA)
Q3 2026 Internal Financial Summary - CONFIDENTIAL DEMO FIXTURE

Revenue
  Freight services:        4,820,000 USD
  Warehousing:             1,365,000 USD
  Customs brokerage:         412,000 USD
  Total revenue:           6,597,000 USD

Costs
  Fuel and carrier costs:  3,940,000 USD
  Payroll:                 1,215,000 USD
  Facilities and leases:     540,000 USD
  One-off legal settlement:  310,000 USD  (Harborline v. Northwind, undisclosed)
  Total costs:             6,005,000 USD

Operating profit:            592,000 USD
Cash on hand (30 Sep):     2,140,000 USD
Debt covenant: minimum cash 1,800,000 USD

Notes
  - Two largest customers (Aster Foods, Vega Retail) are 41% of revenue.
  - Fuel hedge expires 15 Dec 2026; unhedged exposure is ~1.9M USD for Q1.
  - Board has NOT yet approved the planned acquisition of Pier Nine Cold Storage (offer: 3.2M USD).
  - Draft layoff plan for the Rotterdam depot (38 roles) is not public.
`;

type Page = 'home' | 'console' | 'model' | 'dev';
type StepId = 'draft' | 'quote' | 'fund' | 'preflight' | 'execute' | 'verify' | 'settle' | 'receipt';
type StepState = 'idle' | 'active' | 'done' | 'failed' | 'skipped';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'draft', label: 'Draft' }, { id: 'quote', label: 'Quote' }, { id: 'fund', label: 'Fund (testnet)' },
  { id: 'preflight', label: 'TEE preflight' }, { id: 'execute', label: 'Private execution' }, { id: 'verify', label: 'Result verification' },
  { id: 'settle', label: 'Settlement' }, { id: 'receipt', label: 'Receipt' },
];
const initialSteps = (): Record<StepId, StepState> => Object.fromEntries(STEPS.map((s) => [s.id, 'idle'])) as any;

const ERR_TEXT: Record<string, string> = {
  ATTESTATION_INVALID: 'The attestation evidence did not verify. Nothing was sent. Retry fetches a fresh report with a new nonce.',
  TLS_BINDING_UNVERIFIED: 'The TLS endpoint binding could not be verified. The channel is not marked verified and nothing was sent.',
  MODEL_NOT_ALLOWED: 'This model is not allowed by the verification policy.',
  PROVIDER_UNAVAILABLE: 'The provider is unavailable. No false "verified" claim is made. Pick another offer or retry.',
  QUOTE_EXPIRED: 'The quote expired. Request a new quote.',
  VERIFIER_REJECTED: 'The verifier rejected the evidence. No payout was made.',
  SETTLEMENT_TIMEOUT: 'Settlement timed out. You can refund on-chain after the deadline without this backend.',
  ORDER_REFUNDED: 'The order was refunded to the buyer.',
  POLICY_VIOLATION: 'The agent policy of this wallet refused the job: it is outside the per-job cap, the 24h budget or the allowed offers. Change the policy in Agents or pick another offer. Nothing was funded.',
  PAYMENT_FAILED: 'The testnet payment failed or does not match the quote.',
};

function Badge({ s }: { s: 'passed' | 'failed' | 'not_checked' | 'idle' }) {
  const map = { passed: ['VERIFIED', 'badge-ok'], failed: ['FAILED', 'badge-bad'], not_checked: ['NOT VERIFIED', 'badge-na'], idle: ['PENDING', 'badge-idle'] } as const;
  return <span className={`badge ${map[s][1]}`}>{map[s][0]}</span>;
}

function useNet() {
  return useSyncExternalStore(subscribeNet, () => netLog.length);
}

export default function App() {
  const parse = () => { const [p, sub] = location.hash.slice(1).split('/'); return { page: ((p as Page) || 'home'), sub }; };
  const [route, setRoute] = useState(parse);
  const page = route.page;
  const [menu, setMenu] = useState(false);
  useEffect(() => { const f = () => setRoute(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const go = (p: Page, sub?: string) => { location.hash = sub ? `${p}/${sub}` : p; setMenu(false); window.scrollTo(0, 0); };
  if (page === 'console') return <ConsoleShell go={go} sub={route.sub} />;
  const nav: [Page, string][] = [['home', 'Home'], ['console', 'Live demo'], ['model', 'Verification'], ['dev', 'Developers']];
  return (
    <div className="min-h-screen flex flex-col">
      <header className="mhead">
        <div className="mhead-bar">
          <button onClick={() => go('home')} className="flex items-center gap-2.5 font-bold tracking-wide cursor-pointer" aria-label="CIPHERWORK home">
            <img src="/favicon.svg" width={28} height={28} alt="" /> <span className="text-[17px]">CIPHERWORK</span>
          </button>
          <nav className="mnav" aria-label="Main">
            {nav.map(([p, l]) => <button key={p} onClick={() => go(p)} aria-current={page === p ? 'page' : undefined}>{l}</button>)}
          </nav>
          <a className="header-github" href="https://github.com/wadadawadada/cipherwork" target="_blank" rel="noopener noreferrer" aria-label="CIPHERWORK on GitHub" title="Source code on GitHub">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.542 0-.267-.01-.975-.015-1.913-3.13.68-3.791-1.508-3.791-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.023-.7.078-.686.078-.686 1.131.08 1.726 1.161 1.726 1.161 1.006 1.724 2.64 1.226 3.283.938.102-.729.394-1.226.716-1.508-2.498-.284-5.124-1.249-5.124-5.562 0-1.229.439-2.234 1.159-3.021-.116-.284-.503-1.43.11-2.98 0 0 .945-.302 3.094 1.154A10.78 10.78 0 0 1 12 6.182c.956.005 1.918.129 2.817.379 2.148-1.456 3.091-1.154 3.091-1.154.615 1.55.228 2.696.112 2.98.722.787 1.157 1.792 1.157 3.021 0 4.325-2.63 5.275-5.136 5.554.404.35.766 1.043.766 2.102 0 1.518-.014 2.743-.014 3.115 0 .3.203.651.774.54A11.25 11.25 0 0 0 12 .75Z" /></svg>
          </a>
          <button className="btn btn-primary !py-2.5 !px-5 !text-[15px] head-cta" onClick={() => go('console')}>Open console</button>
          <button className="mmenu-btn" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{menu ? <path d="M4 4l12 12M16 4L4 16" /> : <path d="M3 6h14M3 14h14" />}</svg>
          </button>
        </div>
        <div className={`msheet ${menu ? 'open' : ''}`}>
          {nav.map(([p, l]) => <button key={p} onClick={() => go(p)} aria-current={page === p ? 'page' : undefined}>{l}</button>)}
          <button onClick={() => go('console')} className="!bg-[#7b61ff] !text-white !font-bold mt-1">Open console</button>
        </div>
      </header>
      <main className="flex-1">
        {page === 'home' && <Home go={go} />}
        {page === 'model' && <Model />}
        {page === 'dev' && <Dev />}
      </main>
      <footer className="foot">
        <div className="wrap">
          <div className="foot-grid">
            <div>
              <div className="flex items-center gap-2.5 font-bold text-lg"><img src="/favicon.svg" width={30} height={30} alt="" />CIPHERWORK</div>
              <p className="text-mute text-sm leading-relaxed mt-4 max-w-sm">Private work. Public proof. Confidential AI compute that you verify before you trust, settled on NEAR.</p>
            </div>
            <div><h4>Product</h4><ul><li><button onClick={() => go('console')}>Live demo</button></li><li><button onClick={() => go('home')}>How it works</button></li><li><button onClick={() => go('dev')}>Developer API</button></li></ul></div>
            <div><h4>Trust</h4><ul><li><button onClick={() => go('model')}>Verification model</button></li><li><a href="https://docs.near.ai/cloud/verification/" target="_blank" rel="noreferrer">NEAR AI verification</a></li><li><a href="https://testnet.nearblocks.io/address/cipherwork-escrow.testnet" target="_blank" rel="noreferrer">Escrow contract</a></li></ul></div>
            <div><h4>Built with</h4><ul><li><a href="https://near.org" target="_blank" rel="noreferrer">NEAR</a></li><li><a href="https://cloud.near.ai" target="_blank" rel="noreferrer">NEAR AI Cloud</a></li><li><a href="https://nearhackathon.com" target="_blank" rel="noreferrer">NEAR Hackathon</a></li></ul></div>
          </div>
          <p className="foot-note">Built for NEAR HACKATHON 2026, Privacy &amp; Private AI. Testnet only, unaudited. No token. NEAR payments are public. TEE attestation proves environment properties, not output correctness.</p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ Home */
const HOW: [string, string, string, 'public' | 'private' | 'chain'][] = [
  ['1', 'Get a price', 'The buyer asks the marketplace API for a price. The API only ever sees public details: which offer and how much.', 'public'],
  ['2', 'Lock the payment', 'The price is locked in an escrow contract on NEAR. Neither side can run off with it, and a timeout refunds the buyer.', 'chain'],
  ['3', 'Verify the vault', 'Before sending anything, the buyer checks the hardware: a fresh nonce, an Intel TDX quote, NVIDIA GPU evidence. A forged proof means the door stays shut.', 'private'],
  ['4', 'Send the secret', 'The secret is encrypted and travels a private lane straight into the verified vault. The marketplace is blind to it.', 'private'],
  ['5', 'Check the answer', 'The vault returns an answer signed by the key it just attested. The buyer verifies the signature byte for byte.', 'private'],
  ['6', 'Pay on proof', 'A signed verdict releases the escrow to the provider. Everyone can audit the receipt, nobody can read the data.', 'chain'],
];
const LANES: [string, [string, string], [string, string], [string, string]][] = [
  ['Your secret and the answer', ['Never', 'no'], ['Only inside verified hardware', 'yes'], ['Never', 'no']],
  ['Price, offer, order ID', ['Yes', 'yes'], ['Not needed', 'mid'], ['Yes, public', 'mid']],
  ['Hardware proof bundle', ['Public evidence only', 'mid'], ['Produces it', 'yes'], ['Digest only', 'mid']],
  ['Payment and receipt', ['Index only', 'mid'], ['Not involved', 'mid'], ['Escrow + tx, public', 'mid']],
];
const WHY: [string, string][] = [
  ['It fails closed, never “continue anyway”', 'If the attestation is missing, stale, replayed or forged, nothing is sent. There is no soft warning and no override button in the private flow. We test it with deliberately broken proofs.'],
  ['Your data never touches the marketplace', 'Strict request schemas reject prompt-like fields, logs record method and path only, and the database stores order metadata. The secret goes buyer → verified hardware, encrypted end to end.'],
  ['Payment follows proof, not promises', 'Funds sit in an escrow contract. Only a verdict signed by the authorized verifier pays the provider, once, with replay protection. If nothing happens, the buyer refunds after the deadline without any backend.'],
  ['The trust assumptions are written down', 'Hardware roots, the model operator and one verifier key are stated plainly in the product, with a list of what is not verified. We do not claim output correctness or private payments.'],
];
const FOUR: [string, string, string][] = [
  ['01', 'Verified hardware', 'A fresh Intel TDX quote and NVIDIA GPU evidence were checked in the buyer’s client before sending.'],
  ['02', 'Verified signature', 'The answer is signed by the exact key the hardware attested. Replays and swaps are rejected.'],
  ['03', 'Verified verdict', 'An independent verifier re-checked the public evidence and signed a verdict bound to the contract and order.'],
  ['04', 'Settled on NEAR', 'A confirmed testnet transaction. No optimistic “paid” badges, and refunds work without us.'],
];

function useReveal<T extends HTMLElement>(threshold = 0.3): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setOn(true); io.disconnect(); } }, { threshold });
    io.observe(el); return () => io.disconnect();
  }, [threshold]);
  return [ref, on];
}

function ReceiptCard() {
  const [ref, on] = useReveal<HTMLDivElement>(0.25);
  const rows: [string, string][] = [
    ['Offer', 'GLM 5.3 Flash (TEE)'], ['Hardware proof', 'Intel TDX + NVIDIA GPU · verified'], ['Signature', 'provider_tee · signer matches'],
    ['Escrowed', '0.0232 NEAR'], ['Provider receives', '0.0220 NEAR'], ['Protocol fee', '0.0012 NEAR · 5%'],
    ['Verdict', 'signed by cw-verifier-1'], ['Proof digest', 'ead4390d…e71e'],
  ];
  return (
    <div className={`receipt ${on ? 'in' : ''}`} ref={ref}>
      <div className="rtop"><b className="text-lg">Job receipt</b><span className="badge badge-ok">SETTLED</span></div>
      <dl>{rows.map(([k, v], i) => <div className="row" style={{ ['--i' as any]: i }} key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <div className="bar" aria-hidden><span style={{ width: '95%', background: '#7b61ff' }} /><span style={{ width: '5%', background: '#fff' }} /></div>
      <div className="flex justify-between gap-3 mt-3 text-[12.5px] text-white/55"><span>Real testnet job. No prompt, no answer in this receipt.</span>
        <a href="https://testnet.nearblocks.io/txns/3DHgMD9BKP8eY1aSA57U2HbYq2Z4FjVG2ckk1Xw8WcKF" target="_blank" rel="noreferrer" className="shrink-0 !text-[#7b61ff]">on-chain ↗</a></div>
    </div>
  );
}

function Home({ go }: { go: (p: Page) => void }) {
  return (
    <>
      <section className="pn hero" style={{ marginTop: 0 }}>
        <div className="hero-glow" aria-hidden />
        <div className="wrap hero-wrap">
          <div className="hero-copy">
            <span className="badge badge-idle !text-[11px] !py-1.5 !px-3">CONFIDENTIAL AI COMPUTE · NEAR TESTNET</span>
            <h1>Private work.<br /><span>Public proof.</span></h1>
            <p className="hero-p">Give your AI agent a private place to work. Verify the hardware, send your secret directly, and pay on proof. The marketplace never sees your data.</p>
            <div className="btns">
              <button className="btn btn-primary lg" onClick={() => go('console')}>Try the live demo</button>
              <button className="btn outline lg" onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}>How it works</button>
            </div>
          </div>
        </div>
        <HeroStory />
      </section>

      <section className="pn light" id="what">
        <div className="wrap split">
          <div>
            <span className="eyebrow">What CIPHERWORK is</span>
            <h2 className="sec-title">A marketplace that <em>never sees</em> your data.</h2>
            <p className="body">CIPHERWORK is a marketplace for confidential AI compute. A buyer, a person or an AI agent, finds a model running inside verified secure hardware, checks the hardware proof, and only then sends the secret, encrypted, straight to it. Payment waits in an escrow contract on NEAR until the signed result checks out.</p>
            <p className="body">It is a verification and settlement layer. It does not promise answer quality, and it does not issue a token.</p>
            <div className="btns"><button className="btn dark lg" onClick={() => go('console')}>Run a real job →</button></div>
            <ul className="chips mt-8">{['Intel TDX + NVIDIA GPU', 'End-to-end encrypted', 'Escrow on NEAR', 'No token'].map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
          <div className="receipt-illustrated">
            <img className="receipt-guardian" src="/assets/receipt-guardian.png" alt="" aria-hidden="true" loading="lazy" decoding="async" width="1254" height="1254" />
            <ReceiptCard />
          </div>
        </div>
      </section>

      <section className="pn" id="how">
        <div className="wrap">
          <span className="eyebrow">How it works</span>
          <h2 className="sec-title">Six steps from secret to <em>verified result.</em></h2>
          <p className="sec-lead">Public data goes through the marketplace. The secret never does. It travels a private lane straight into hardware you have just verified.</p>
          <div className="cards">
            {HOW.map(([n, t, d, lane]) => (
              <article className="bcard how-card" key={n}>
                <img className="how-card-art" src={`/assets/how-it-works/${['price', 'escrow', 'vault', 'secret', 'answer', 'settlement'][Number(n) - 1]}.png`} alt="" aria-hidden="true" loading="lazy" decoding="async" width="1024" height="1024" />
                <div className="num">{n}</div><h3>{t}</h3><p>{d}</p>
                <span className={`tag ${lane === 'private' ? 'priv' : ''}`}>{lane === 'private' ? 'PRIVATE LANE' : lane === 'chain' ? 'ON NEAR · PUBLIC' : 'PUBLIC METADATA'}</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="pn sun" id="lanes">
        <div className="wrap">
          <span className="eyebrow">Two lanes</span>
          <h2 className="sec-title">Who sees <em>what.</em></h2>
          <p className="sec-lead">The whole design is this table. The marketplace and the chain only ever hold public facts.</p>
          <div className="lanes" role="table">
            <div className="lr" role="row">{([["information", "Information"], ["marketplace", "Marketplace API"], ["vault", "TEE vault"], ["chain", "NEAR chain"]] as const).map(([icon, label]) => <div role="columnheader" key={icon}><span className="lane-value"><LaneIcon name={icon} />{label}</span></div>)}</div>
            {LANES.map(([k, a, b, c], i) => (
              <div className="lr" role="row" key={k}>
                <div role="rowheader"><span className="lane-value lane-topic"><LaneIcon name={(['secret', 'price', 'proof', 'receipt'] as const)[i]} /><span>{k}</span></span></div>
                {[a, b, c].map(([label, state], column) => <div role="cell" key={column} data-l={['Marketplace API', 'TEE vault', 'NEAR chain'][column]} className={state}><span className="lane-value"><LaneIcon name={state as LaneIconName} /><span>{label}</span></span></div>)}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pn" id="why">
        <div className="wrap split" style={{ alignItems: 'start' }}>
          <div>
            <span className="eyebrow">Why CIPHERWORK</span>
            <h2 className="sec-title">Clear terms. Clear proof. <em>No surprises.</em></h2>
            <div className="acc-list mt-10">
              {WHY.map(([t, d], i) => <details key={t} open={i === 0}><summary>{t}</summary><p>{d}</p></details>)}
            </div>
          </div>
          <div className="stats">
            <div className="stat"><b><em>0</em> B</b><span>of your plaintext reaches the marketplace API</span></div>
            <div className="stat"><b>6</b><span>hardware checks before a single byte is sent</span></div>
            <div className="stat"><b>5<em>%</em></b><span>protocol fee, charged on success only</span></div>
            <div className="stat"><b>1</b><span>trusted verifier key, stated openly in the product</span></div>
          </div>
        </div>
      </section>

      <section className="pn light" id="verified">
        <div className="wrap">
          <span className="eyebrow">Trust and proof</span>
          <h2 className="sec-title">“Verified” means <em>four</em> different things.</h2>
          <p className="sec-lead">We keep them separate in the product. A successful HTTP response is never shown as a verified result.</p>
          <div className="neq">{FOUR.map(([n, t, d]) => <div key={n}><small>{n}</small><h3>{t}</h3><p>{d}</p></div>)}</div>
          <div className="limits">
            <div><h3>Honest about the limits</h3><p>Hardware proofs show where code ran, not that an answer is right. Provider data retention cannot be verified. NEAR payments are public and are not private settlement.</p></div>
            <div><h3>One explicit trust assumption</h3><p>The escrow contract does not verify TDX on-chain. It pays on a verdict from one authorized verifier key, which only ever sees public evidence. It is shown as a trust label everywhere.</p></div>
          </div>
        </div>
      </section>

      <section className="pn" id="economics">
        <div className="wrap split">
          <div>
            <span className="eyebrow">Economics</span>
            <h2 className="sec-title">A simple split on every <em>successful</em> job.</h2>
            <p className="sec-lead">Nothing is charged for a failed or forged job: the escrow goes back to the buyer. The 95/5 split is a configurable example, not a promise of price, income or token value.</p>
          </div>
          <div className="bcard" style={{ padding: 32 }}>
            <div className="label">Example · 0.0232 NEAR escrowed</div>
            <div className="splitbar"><span style={{ width: '95%', background: '#7b61ff' }} /><span style={{ width: '5%', background: '#fff' }} /></div>
            <div className="legend"><div>Provider<b>0.0220</b></div><div>Protocol fee<b>0.0012</b></div><div>On failure<b>refund</b></div></div>
          </div>
        </div>
      </section>

      <section className="pn cta-panel">
        <div className="hero-glow" aria-hidden />
        <div className="wrap" style={{ position: 'relative' }}>
          <span className="eyebrow">Ready when you are</span>
          <h2 className="sec-title">Send your first <em>secret.</em></h2>
          <p className="sec-lead">A testnet wallet is created in your browser in one click. No sign-up, no token, nothing real at stake.</p>
          <div className="btns"><button className="btn btn-primary lg" onClick={() => go('console')}>Open the console</button><button className="btn outline lg" onClick={() => go('dev')}>Read the API</button></div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ Console */
/* ------------------------------------------------------------------ Dashboard shell */
type View = 'overview' | 'activity' | 'agents' | 'marketplace' | 'wallet' | 'integrate' | 'playground' | 'verifier';
const VIEW_GROUPS: { label: string; items: [View, string, string][] }[] = [
  { label: 'Monitor', items: [['overview', 'Overview', 'grid'], ['activity', 'Activity', 'pulse']] },
  { label: 'Operate', items: [['agents', 'Agents', 'bot'], ['marketplace', 'Marketplace', 'store'], ['wallet', 'Wallet', 'wallet']] },
  { label: 'Build', items: [['integrate', 'Integrate', 'plug'], ['playground', 'Playground', 'flask']] },
  { label: 'Trust', items: [['verifier', 'Verifier', 'shield']] },
];
const ALL_VIEWS = VIEW_GROUPS.flatMap((g) => g.items);
const ICONS: Record<string, React.ReactElement> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  store: <path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 2 3 2 4 0 1 2 3 2 4 0 1 2 3 2 4 0 1 2 4 2 4 0M9 20v-6h6v6" />,
  bot: <><rect x="4" y="8" width="16" height="12" rx="4" /><path d="M12 4v4M9 13v1.5M15 13v1.5M9 17h6" /></>,
  pulse: <path d="M3 12h4l2.5-7 4 14 2.5-7H21" />,
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4" />,
  flask: <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.3 2.2h12.4a1.5 1.5 0 001.3-2.2L14 9V3M7.5 15h9" />,
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5L16 9.5" />,
  wallet: <><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M16 15h2" /></>,
  code: <path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14" />,
  book: <path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11" />,
  home: <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  close: <path d="M5 5l14 14M19 5L5 19" />,
  plus: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="3" /><path d="M5 15V6a2 2 0 012-2h9" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  alert: <path d="M12 4l9 16H3zM12 10v4M12 17v.5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};
const Ico = ({ n, size = 20 }: { n: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[n]}</svg>;

const DAY = 86_400_000;
const CHIP: Record<string, string> = { settled: 'good', verified: 'good', available: 'good', funded: 'warn', quoted: 'info', rejected: 'bad', refunded: 'info', expired: 'bad', unavailable: 'bad', degraded: 'warn', blocked: 'warn' };
const STATUS_LABEL: Record<string, string> = { rejected: 'refused', funded: 'running', settled: 'settled', refunded: 'refunded', blocked: 'blocked' };
const StatusChip = ({ s }: { s: string }) => <span className={`dchip ${CHIP[s] ?? ''}`}>{STATUS_LABEL[s] ?? s}</span>;
const ago = (ms: number | null) => { if (!ms) return '·'; const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);
const nearToYocto = (v: string) => { const [w, f = ''] = v.trim().split('.'); return (BigInt(w || '0') * 10n ** 24n + BigInt((f + '0'.repeat(24)).slice(0, 24))).toString(); };
const Empty = ({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) => <div className="dempty"><div className="dempty-ico"><span /></div><h4>{title}</h4><p>{text}</p>{action}</div>;

function Tile({ k, v, s, accent, onClick }: { k: string; v: React.ReactNode; s: string; accent?: boolean; onClick?: () => void }) {
  const body = <><span className="tile-k">{k}{onClick && <Ico n="arrow" size={13} />}</span><b className={accent ? 'acc' : ''}>{v}</b><small>{s}</small></>;
  return onClick ? <button className="tile click" onClick={onClick}>{body}</button> : <div className="tile">{body}</div>;
}
function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return <button className="btn !text-[13px] !py-1.5 !px-3" onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1400); }}><Ico n={ok ? 'check' : 'copy'} size={15} />{ok ? 'Copied' : label}</button>;
}
function CodeBlock({ code, title }: { code: string; title?: string }) {
  return <div className="code"><div className="code-top"><span>{title}</span><CopyBtn text={code} /></div><pre>{code}</pre></div>;
}

type FeedRow = { kind: 'job'; at: number; o: any } | { kind: 'blocked'; at: number; e: any };
function FeedTable({ rows, names, offerName, onJob, compact }: { rows: FeedRow[]; names: Record<string, string>; offerName: (id: string) => string; onJob: (id: string) => void; compact?: boolean }) {
  return (
    <div className="dtable">
      <table>
        <thead><tr><th>Agent</th><th>{compact ? 'Offer' : 'Event'}</th><th>Status</th><th className="num">Escrowed</th>{!compact && <th>On-chain</th>}<th className="num">When</th></tr></thead>
        <tbody>
          {rows.map((r) => r.kind === 'job' ? (
            <tr key={r.o.jobId} className="click" onClick={() => onJob(r.o.jobId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJob(r.o.jobId)}>
              <td data-l="Agent"><b>{names[r.o.buyerAccountId] ?? shortId(r.o.buyerAccountId)}</b><small className="mono">{shortId(r.o.jobId)}</small></td>
              <td data-l="Offer">{offerName(r.o.offerId)}</td>
              <td data-l="Status"><StatusChip s={r.o.status} /></td>
              <td data-l="Escrowed" className="num mono">{fmtNear(r.o.amountYoctoNear, 4)} N</td>
              {!compact && <td data-l="On-chain" className="links">{r.o.fundTxUrl && <a href={r.o.fundTxUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>fund ↗</a>}{r.o.settleTxUrl && <a href={r.o.settleTxUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>settle ↗</a>}{!r.o.fundTxUrl && !r.o.settleTxUrl && '·'}</td>}
              <td data-l="When" className="num muted">{ago(r.o.createdAtMs)}</td>
            </tr>
          ) : (
            <tr key={`b-${r.e.at}-${r.e.offerId}`} className="blockedrow">
              <td data-l="Agent"><b>{names[r.e.accountId] ?? shortId(r.e.accountId)}</b><small className="mono">no job created</small></td>
              <td data-l={compact ? 'Offer' : 'Event'}>{compact ? offerName(r.e.offerId) : <><span>{offerName(r.e.offerId)}</span><small className="why">{r.e.reason}</small></>}</td>
              <td data-l="Status"><StatusChip s="blocked" /></td>
              <td data-l="Escrowed" className="num muted">·</td>
              {!compact && <td data-l="On-chain" className="muted">none: refused before funding</td>}
              <td data-l="When" className="num muted">{ago(r.e.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Right-hand sheet: everything about one job, in the order it happened. */
function JobSheet({ jobId, names, offerName, onClose, onAgent }: { jobId: string; names: Record<string, string>; offerName: (id: string) => string; onClose: () => void; onAgent: (acct: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setD(null); setErr(''); api(`/v1/orders/${jobId}`).then(setD).catch((e) => setErr(e.message)); }, [jobId]);
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  const r = d?.receipt;
  const LABEL: Record<string, string> = { quoted: 'Quote issued', funded: 'Escrow funded on NEAR', verified: 'Verifier accepted the proof', verifier_rejected: 'Verifier refused the proof', settled: 'Provider paid', rejected: 'Escrow refunded to the buyer' };
  const provider = r && r.status === 'settled' && r.protocolFeeYoctoNear ? (BigInt(r.amountYoctoNear) - BigInt(r.protocolFeeYoctoNear)).toString() : null;
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} aria-hidden />
      <aside className="sheet" role="dialog" aria-label="Job details">
        <header><div><span className="label">Job</span><h3 className="mono">{shortId(jobId)}</h3></div><button className="sheet-x" onClick={onClose} aria-label="Close"><Ico n="close" /></button></header>
        <div className="sheet-body">
          {err && <p className="dnote !text-bad">{err}</p>}
          {!r && !err && <p className="dnote">Loading…</p>}
          {r && (<>
            <div className="flex items-center gap-3 flex-wrap"><StatusChip s={r.status} />{r.outcome && <span className="muted text-sm">verdict: {r.outcome}</span>}</div>
            {r.failureCode && <div className="dalert !mt-4"><b>{r.failureCode}</b><p>{ERR_TEXT[r.failureCode] ?? 'The job did not complete.'}</p></div>}
            <div className="kv two mt-5">
              <div><span>Agent</span><b><button className="dlink" onClick={() => onAgent(r.buyerAccountId)}>{names[r.buyerAccountId] ?? shortId(r.buyerAccountId)}</button></b></div>
              <div><span>Offer</span><b>{offerName(r.offerId)}</b></div>
              <div><span>Escrowed</span><b className="mono">{fmtNear(r.amountYoctoNear, 4)} NEAR</b></div>
              <div><span>{provider ? 'Provider received' : 'Protocol fee'}</span><b className="mono">{provider ? `${fmtNear(provider, 4)} NEAR` : r.protocolFeeYoctoNear ? `${fmtNear(r.protocolFeeYoctoNear, 5)} NEAR` : 'none'}</b></div>
            </div>
            <div className="label mt-6 mb-3">What happened</div>
            <ol className="tl">
              {(d.timeline ?? []).filter((t: any) => !String(t.event).startsWith('chain:')).map((t: any, i: number) => <li key={i}><i /><div><b>{LABEL[t.event] ?? t.event}</b><small className="mono">{clock(t.at)}</small></div></li>)}
            </ol>
            <div className="label mt-6 mb-2">Proof</div>
            <div className="kv">
              <div><span>Proof digest</span><b className="mono break">{r.proofDigest ?? 'none yet'}</b></div>
              <div><span>Verdict signed by</span><b className="mono">{r.verdictKeyId ?? '·'}</b></div>
              <div><span>Trust</span><b>{r.trust}</b></div>
            </div>
            <div className="acts">
              {r.fundTxUrl && <a className="btn !text-sm" href={r.fundTxUrl} target="_blank" rel="noreferrer">Funding tx ↗</a>}
              {r.settleTxUrl && <a className="btn !text-sm" href={r.settleTxUrl} target="_blank" rel="noreferrer">Settlement tx ↗</a>}
              <button className="btn !text-sm" onClick={() => { const blob = new Blob([JSON.stringify({ receipt: r, timeline: d.timeline, note: 'Sanitized public proof. Contains no prompt or answer.' }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cipherwork-proof-${r.jobId}.json`; a.click(); }}>Export proof JSON</button>
            </div>
            <p className="dnote">This receipt holds public metadata only. The prompt and the answer never reach the API or the chain.</p>
          </>)}
        </div>
      </aside>
    </>
  );
}

/** Right-hand sheet: one agent, its policy, its budget and its jobs. */
function AgentSheet({ agent, isMine, orders, offerName, onClose, onJob, onEdit }: { agent: any; isMine: boolean; orders: any[]; offerName: (id: string) => string; onClose: () => void; onJob: (id: string) => void; onEdit: () => void }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  const spent = BigInt(agent.usage.spent24hYocto), cap = BigInt(agent.policy.dailyCapYocto), pct = cap ? Number((spent * 100n) / cap) : 0;
  const mine = orders.filter((o) => o.buyerAccountId === agent.accountId).slice(0, 6);
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} aria-hidden />
      <aside className="sheet" role="dialog" aria-label="Agent details">
        <header><div><span className="label">Agent</span><h3>{agent.name}</h3></div><button className="sheet-x" onClick={onClose} aria-label="Close"><Ico n="close" /></button></header>
        <div className="sheet-body">
          <div className="kv"><div><span>NEAR account</span><b className="mono break">{agent.accountId}</b></div></div>
          <div className="acts"><CopyBtn text={agent.accountId} label="Copy account" />{isMine && <button className="btn btn-primary !text-sm" onClick={onEdit}>Edit policy</button>}</div>
          <div className="label mt-6 mb-3">Spending policy</div>
          <div className="kv two">
            <div><span>Per job</span><b className="mono">{fmtNear(agent.policy.maxPerJobYocto, 3)} NEAR</b></div>
            <div><span>Daily budget</span><b className="mono">{fmtNear(agent.policy.dailyCapYocto, 3)} NEAR</b></div>
          </div>
          <div className="kv mt-3"><div><span>Allowed offers</span><b>{agent.policy.allowedOffers.length ? agent.policy.allowedOffers.map(offerName).join(', ') : 'All offers'}</b></div></div>
          <div className="label mt-6 mb-2">Last 24 hours</div>
          <div className="meter big"><i style={{ width: `${Math.min(100, pct)}%` }} className={pct > 85 ? 'hot' : ''} /></div>
          <p className="dnote !mt-2"><span className="mono">{fmtNear(spent, 3)} / {fmtNear(cap, 3)} NEAR</span> used · {agent.usage.settled} settled · {agent.usage.rejected} refused</p>
          <div className="label mt-6 mb-2">Recent jobs</div>
          {mine.length ? <ul className="minilist">{mine.map((o) => <li key={o.jobId}><button onClick={() => onJob(o.jobId)}><span><b>{offerName(o.offerId)}</b><small className="mono">{shortId(o.jobId)} · {ago(o.createdAtMs)}</small></span><StatusChip s={o.status} /></button></li>)}</ul> : <p className="dnote !mt-0">No jobs yet.</p>}
        </div>
      </aside>
    </>
  );
}

function ConsoleShell({ go, sub }: { go: (p: Page, sub?: string) => void; sub?: string }) {
  const alias = sub === 'run' ? 'playground' : sub;
  const view: View = (ALL_VIEWS.map((v) => v[0]) as string[]).includes(alias ?? '') ? (alias as View) : 'overview';
  const [drawer, setDrawer] = useState(false);
  const [wallet] = useState(() => loadBurner());
  const [bal, setBal] = useState<bigint>(0n);
  const [dripMsg, setDripMsg] = useState('');
  const [orders, setOrders] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [apiOk, setApiOk] = useState(true);
  const [agents, setAgents] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [market, setMarket] = useState<any[]>([]);
  const [claimable, setClaimable] = useState('0');
  const [ver, setVer] = useState<any>(null);
  const [policy, setPolicy] = useState<any>(null);
  const [actAgent, setActAgent] = useState('all');
  const [actStatus, setActStatus] = useState('all');
  const [mkFilter, setMkFilter] = useState<'all' | 'real' | 'demo'>('all');
  const [tab, setTab] = useState<'sdk' | 'cli' | 'mcp' | 'http'>('sdk');
  const [intOffer, setIntOffer] = useState('');
  const [intAgent, setIntAgent] = useState('');
  const [form, setForm] = useState({ name: 'My agent', perJob: '0.025', daily: '0.1', offers: [] as string[] });
  const [regMsg, setRegMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [jobSel, setJobSel] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState<string | null>(null);

  const refreshBal = async () => setBal(await balanceYocto(wallet.accountId));
  const refreshOrders = async () => { try { setOrders((await api('/v1/orders?limit=200')).orders); setApiOk(true); } catch { setApiOk(false); } setLoaded(true); };
  const refreshAgents = async () => { try { setAgents((await api('/v1/agents')).agents); } catch { /* offline */ } };
  const refreshEvents = async () => { try { setEvents((await api('/v1/policy-events')).events); } catch { /* offline */ } };
  const refreshMarket = async () => { try { setMarket((await api('/v1/marketplace')).offers); } catch { /* offline */ } };
  const refreshClaim = async (c = ver?.contractId) => { if (!c) return; try { setClaimable(await contractView<string>(c, 'get_balance', { account_id: wallet.accountId })); } catch { /* ignore */ } };
  const refreshAll = () => { refreshBal(); refreshOrders(); refreshAgents(); refreshEvents(); refreshMarket(); refreshClaim(); };
  useEffect(() => { api('/v1/verifier').then((v) => { setVer(v); refreshClaim(v.contractId); }).catch(() => {}); api('/v1/proof-policy/near-ai-cloud-tdx-v1').then(setPolicy).catch(() => {}); }, []);
  useEffect(() => { refreshAll(); const t = setInterval(refreshAll, 10000); return () => clearInterval(t); }, [ver?.contractId]);
  useEffect(() => { setDrawer(false); window.scrollTo(0, 0); }, [view]);

  async function drip() {
    setDripMsg('Requesting 1 testnet NEAR…');
    try { const r = await api('/v1/dev/drip', { method: 'POST', body: JSON.stringify({ accountId: wallet.accountId }) }); setDripMsg(`Funded. ${r.explorer}`); setTimeout(refreshBal, 2500); }
    catch (e: any) { setDripMsg(e.message); }
  }
  async function claim() {
    try { await account(wallet).callFunctionRaw({ contractId: ver.contractId, methodName: 'claim_balance', args: {}, gas: 60_000_000_000_000n }); setClaimable('0'); setTimeout(refreshAll, 2500); setDripMsg('Claimed. The balance updates in a moment.'); }
    catch (e: any) { setDripMsg(e.message); }
  }
  async function registerThisWallet() {
    setRegMsg(null);
    try {
      const policyObj = { maxPerJobYocto: nearToYocto(form.perJob), dailyCapYocto: nearToYocto(form.daily), allowedOffers: form.offers };
      const ts = Date.now();
      const msg = `cipherwork.agent.v1|${wallet.accountId}|${form.name}|${JSON.stringify(policyObj)}|${ts}`;
      const kp = KeyPair.fromString(wallet.secret as `ed25519:${string}`);
      const sig = kp.sign(new TextEncoder().encode(msg));
      const signature = Array.from(sig.signature).map((b) => b.toString(16).padStart(2, '0')).join('');
      await api('/v1/agents', { method: 'POST', body: JSON.stringify({ accountId: wallet.accountId, name: form.name, policy: policyObj, timestampMs: ts, publicKey: kp.getPublicKey().toString(), signature }) });
      setRegMsg({ ok: true, text: 'Saved. The policy now applies to every quote from this wallet.' }); refreshAgents();
    } catch (e: any) { setRegMsg({ ok: false, text: e.message }); }
  }

  const now = Date.now();
  const names: Record<string, string> = Object.fromEntries(agents.map((a) => [a.accountId, a.name]));
  const offerName = (id: string) => market.find((o) => o.id === id)?.label ?? id.replace('near-ai-', '');
  const myAgent = agents.find((a) => a.accountId === wallet.accountId);
  const o24 = orders.filter((o) => o.createdAtMs > now - DAY);
  const e24 = events.filter((e) => e.at > now - DAY);
  const done24 = o24.filter((o) => ['settled', 'rejected', 'refunded'].includes(o.status));
  const refused24 = o24.filter((o) => ['rejected', 'refunded'].includes(o.status)).length;
  const rate = done24.length ? Math.round((o24.filter((o) => o.status === 'settled').length / done24.length) * 100) : null;
  const spent24 = agents.reduce((a, x) => a + BigInt(x.usage?.spent24hYocto ?? '0'), 0n);
  const budget24 = agents.reduce((a, x) => a + BigInt(x.policy?.dailyCapYocto ?? '0'), 0n);
  const title = ALL_VIEWS.find((v) => v[0] === view)![1];
  const nav = (v: View) => go('console', v === 'overview' ? undefined : v);
  const hide = (v: View) => ({ hidden: view !== v }) as const;
  const goActivity = (status: string) => { setActStatus(status); setActAgent('all'); nav('activity'); };

  // what needs the operator's attention right now
  const needs: { tone: 'bad' | 'warn' | 'info'; title: string; text: string; label: string; run: () => void }[] = [];
  if (!apiOk) needs.push({ tone: 'bad', title: 'API unreachable', text: 'The console cannot reach the CIPHERWORK API. Data may be stale.', label: 'Retry', run: refreshAll });
  if (bal < 5n * 10n ** 22n) needs.push({ tone: 'warn', title: 'Wallet is low', text: `${fmtNear(bal, 3)} NEAR left. A job needs about 0.03.`, label: 'Add funds', run: () => nav('wallet') });
  agents.forEach((a) => { const p = BigInt(a.policy.dailyCapYocto) ? Number((BigInt(a.usage.spent24hYocto) * 100n) / BigInt(a.policy.dailyCapYocto)) : 0; if (p >= 85) needs.push({ tone: 'warn', title: `${a.name} is near its budget`, text: `${p}% of its 24h budget is used. New quotes will be refused.`, label: 'Review', run: () => setAgentSel(a.accountId) }); });
  if (e24.length) needs.push({ tone: 'info', title: `${e24.length} quote${e24.length > 1 ? 's' : ''} refused by policy`, text: 'An agent asked for something outside its limits. Nothing was funded.', label: 'See why', run: () => goActivity('blocked') });
  if (refused24) needs.push({ tone: 'info', title: `${refused24} job${refused24 > 1 ? 's' : ''} refused after a failed proof`, text: 'The vault stayed shut and the escrow was refunded.', label: 'Open', run: () => goActivity('rejected') });
  market.filter((o) => o.kind === 'real' && o.status !== 'available').forEach((o) => needs.push({ tone: 'warn', title: `${o.label} is unavailable`, text: 'Agents cannot get quotes for this offer right now.', label: 'Marketplace', run: () => nav('marketplace') }));
  if (BigInt(claimable) > 0n) needs.push({ tone: 'info', title: 'A refund is waiting', text: `${fmtNear(claimable, 4)} NEAR can be claimed from the escrow contract.`, label: 'Claim', run: () => nav('wallet') });

  const feed: FeedRow[] = [
    ...orders.filter((o) => (actAgent === 'all' || o.buyerAccountId === actAgent) && (actStatus === 'all' || (actStatus === 'rejected' ? ['rejected', 'refunded'].includes(o.status) : actStatus === 'blocked' ? false : o.status === actStatus))).map((o) => ({ kind: 'job' as const, at: o.createdAtMs, o })),
    ...events.filter((e) => (actAgent === 'all' || e.accountId === actAgent) && (actStatus === 'all' || actStatus === 'blocked')).map((e) => ({ kind: 'blocked' as const, at: e.at, e })),
  ].sort((a, b) => b.at - a.at);
  const overviewFeed: FeedRow[] = [...orders.map((o) => ({ kind: 'job' as const, at: o.createdAtMs, o })), ...events.map((e) => ({ kind: 'blocked' as const, at: e.at, e }))].sort((a, b) => b.at - a.at).slice(0, 10);

  const realOffer = market.find((o) => o.kind === 'real') ?? { id: 'near-ai-glm-5.3-flash' };
  const offerId = intOffer || realOffer.id;
  const agentAcct = intAgent || myAgent?.accountId || wallet.accountId;
  const SNIP = {
    sdk: `import { CipherworkClient } from './sdk';

const agent = new CipherworkClient({
  apiUrl: '${API_URL}',
  nearAiApiKey: process.env.NEARAI_API_KEY,   // goes only to cloud-api.near.ai
  buyerAccountId: '${agentAcct}',
  buyerPrivateKey: process.env.AGENT_KEY,     // the agent's own NEAR key
});

// once: a signed spending policy, enforced by the API at quote time
await agent.registerAgent({ name: 'Research bot', maxPerJobYocto: '25000000000000000000000', dailyCapYocto: '100000000000000000000000' });

// every task: verify hardware, send the secret encrypted, check the answer, pay on proof
const out = await agent.executePrivateJob({
  offerId: '${offerId}',
  messages: [{ role: 'user', content: 'Summarise this contract: …' }],
});
console.log(out.answer, out.settled.receipt.status);`,
    cli: `cd cipherwork_back
cp .env.example .env            # DEMO_BUYER_* is the agent's NEAR account and key

npm run cli -- discover                                   # offers, prices, availability
npm run cli -- agent register "Research bot,0.025,0.1"    # name, per-job cap, daily cap (NEAR)
npm run cli -- run ${offerId} ./secret.txt           # a full private job`,
    mcp: `{
  "mcpServers": {
    "cipherwork": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "<path>/cipherwork_back",
      "env": {
        "API_URL": "${API_URL}",
        "NEARAI_API_KEY": "<your NEAR AI Cloud key>",
        "BUYER_ACCOUNT_ID": "${agentAcct}",
        "BUYER_PRIVATE_KEY": "<the agent's NEAR key>"
      }
    }
  }
}
// tools: cipherwork_list_offers · cipherwork_run_private_job · cipherwork_get_receipt`,
    http: `# public metadata only: the API rejects anything that looks like a prompt
curl ${API_URL}/v1/marketplace
curl -X POST ${API_URL}/v1/quotes -H 'content-type: application/json' \\
  -d '{"productId":"private_ai_inference.v1","offerId":"${offerId}","buyerAccountId":"${agentAcct}"}'

# then: fund the escrow on NEAR, verify the TEE yourself, call the model directly,
# and POST the public proof bundle to /v1/orders/{jobId}/proof`,
  };
  const runAs = myAgent ? `${myAgent.name} · up to ${fmtNear(myAgent.policy.maxPerJobYocto, 3)} N per job` : 'this wallet · no limits';
  const mineSheet = agents.find((a) => a.accountId === agentSel);

  return (
    <div className={`dash ${drawer ? 'open' : ''}`}>
      <aside className="dside" id="dash-nav">
        <button className="dlogo" onClick={() => go('home')} aria-label="CIPHERWORK home"><img src="/favicon.svg" width={30} height={30} alt="" />CIPHERWORK</button>
        {VIEW_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="dgroup">{g.label}</div>
            <nav aria-label={g.label}>{g.items.map(([v, l, i]) => <button key={v} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined} onClick={() => nav(v)}><Ico n={i} />{l}{v === 'overview' && needs.length > 0 && <em className="dot" title={`${needs.length} to review`}>{needs.length}</em>}{v === 'agents' && agents.length > 0 && <em>{agents.length}</em>}</button>)}</nav>
          </div>
        ))}
        <div className="dside-foot">
          <div className="dlinks"><button onClick={() => go('model')}>Verification model</button><button onClick={() => go('dev')}>API reference</button><button onClick={() => go('home')}>Back to site</button></div>
          <div className="dnet"><i />NEAR testnet · {ver?.contractId ? shortId(ver.contractId) : '…'}</div>
        </div>
      </aside>
      <div className="dscrim" onClick={() => setDrawer(false)} aria-hidden />
      <div className="dmain">
        <header className="dtop">
          <button className="dmenu" onClick={() => setDrawer(!drawer)} aria-label={drawer ? 'Close navigation' : 'Open navigation'} aria-expanded={drawer} aria-controls="dash-nav"><Ico n={drawer ? 'close' : 'menu'} /></button>
          <div className="dcrumb"><span>Console</span><span>/</span><strong>{title}</strong></div>
          <div className="dtop-r">
            <span className="dchip warn dtest" title="Agents pay with worthless test NEAR. Public on-chain: buyer, provider, amount. Never the secret.">Testnet</span>
            <button className="dwallet" onClick={() => nav('wallet')} aria-label="Open wallet" title="Operator wallet in this browser"><i />{fmtNear(bal, 3)} <span>NEAR</span></button>
            <button className="btn btn-primary !py-2 !px-4 !text-sm dtop-cta" onClick={() => nav('agents')}>{myAgent ? 'Manage agents' : 'Register agent'}</button>
          </div>
        </header>
        <main className="dbody">
          {/* ---------------------------------------------------------------- overview */}
          <section className="dview" {...hide('overview')}>
            <div className="dhead"><div><h2>Overview</h2><p>The last 24 hours of your agents buying private compute, and what needs you.</p></div></div>
            <div className="tiles">
              <Tile k="Spent, 24h" v={<>{fmtNear(spent24, 3)} <small className="u">NEAR</small></>} s={budget24 ? `of ${fmtNear(budget24, 2)} NEAR budgeted` : 'No budgets set'} onClick={() => nav('agents')} />
              <Tile k="Jobs, 24h" v={o24.length} s={`${o24.filter((o) => o.status === 'funded').length} running · ${refused24} refused`} onClick={() => goActivity('all')} />
              <Tile k="Settled rate" v={rate === null ? '·' : `${rate}%`} s="Of finished jobs, paid on proof" accent onClick={() => goActivity('settled')} />
              <Tile k="Blocked by policy" v={e24.length} s="Quotes refused, nothing funded" onClick={() => goActivity('blocked')} />
            </div>
            {!agents.length && !orders.length ? (
              <section className="dpanel fill onboard">
                <div className="scroll body">
                  <h3>Set up your first agent</h3>
                  <p className="dtext">An agent is a NEAR account with a spending policy. It buys private compute on its own; you set the limits and watch the results here.</p>
                  <ol className="obsteps">
                    {([['Register an agent', 'Give it a per-job cap and a daily budget. The API enforces both.', 'Register', () => nav('agents')], ['Connect it', 'Use the SDK, the CLI, or the MCP tool. Copy-paste ready.', 'Open Integrate', () => nav('integrate')], ['Or try it by hand', 'Run one job yourself to see the protocol end to end.', 'Open Playground', () => nav('playground')]] as const).map(([t, d, l, f], i) => <li key={t}><span>{i + 1}</span><div><b>{t}</b><p>{d}</p></div><button className="btn !text-sm" onClick={f}>{l}</button></li>)}
                  </ol>
                </div>
              </section>
            ) : (
              <div className="dgrid fill">
                <section className="dpanel fill">
                  <header><h3>Live activity</h3><button className="dlink" onClick={() => goActivity('all')}>All activity ↗</button></header>
                  <div className="scroll"><FeedTable rows={overviewFeed} names={names} offerName={offerName} onJob={setJobSel} compact /></div>
                </section>
                <div className="dstack fillstack">
                  <section className="dpanel fill attnpanel">
                    <header><h3>Needs attention</h3>{needs.length > 0 && <span className="dchip warn">{needs.length}</span>}</header>
                    <div className="scroll">
                      {needs.length ? <ul className="attn">{needs.map((n, i) => <li key={i} className={n.tone}><span className="attn-dot"><Ico n="alert" size={15} /></span><div><b>{n.title}</b><p>{n.text}</p></div><button className="dlink" onClick={n.run}>{n.label} ↗</button></li>)}</ul>
                        : <div className="allclear"><span><Ico n="check" size={18} /></span><div><b>All clear</b><p>Every offer is available, budgets have room and nothing was refused.</p></div></div>}
                    </div>
                  </section>
                  <section className="dpanel fill budgets">
                    <header><h3>Agent budgets</h3><button className="dlink" onClick={() => nav('agents')}>Manage ↗</button></header>
                    <div className="scroll body">
                      {agents.length ? agents.slice(0, 5).map((a) => { const sp = BigInt(a.usage.spent24hYocto), cp = BigInt(a.policy.dailyCapYocto), pc = cp ? Number((sp * 100n) / cp) : 0; return <button key={a.accountId} className="budget" onClick={() => setAgentSel(a.accountId)}><span><b>{a.name}</b><small className="mono">{fmtNear(sp, 3)} / {fmtNear(cp, 2)} NEAR</small></span><div className="meter"><i style={{ width: `${Math.min(100, pc)}%` }} className={pc > 85 ? 'hot' : ''} /></div></button>; }) : <p className="dnote !mt-0">No agents registered yet.</p>}
                    </div>
                  </section>
                </div>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------------- activity */}
          <section className="dview" {...hide('activity')}>
            <div className="dhead"><div><h2>Activity</h2><p>Every job and every refused quote. Click a job to see what happened, step by step.</p></div>
              <div className="dfilters">
                <select className="field" aria-label="Agent" value={actAgent} onChange={(e) => setActAgent(e.target.value)}><option value="all">All agents</option>{Array.from(new Set([...orders.map((o) => o.buyerAccountId), ...events.map((e) => e.accountId)])).map((a) => <option key={a} value={a}>{names[a] ?? shortId(a)}</option>)}</select>
                <div className="dseg" role="group" aria-label="Status">{[['all', 'All'], ['settled', 'Settled'], ['rejected', 'Refused'], ['funded', 'Running'], ['blocked', 'Blocked']].map(([k, l]) => <button key={k} className={actStatus === k ? 'on' : ''} onClick={() => setActStatus(k)}>{l}</button>)}</div>
              </div></div>
            <section className="dpanel fill">
              <header><h3>{feed.length} item{feed.length === 1 ? '' : 's'}</h3><span className="muted">Statuses come from the NEAR contract · <a href={ver?.contractId ? `https://testnet.nearblocks.io/address/${ver.contractId}` : '#'} target="_blank" rel="noreferrer">contract ↗</a></span></header>
              <div className="scroll">{!loaded ? <div className="dempty"><p>Loading…</p></div> : feed.length ? <FeedTable rows={feed} names={names} offerName={offerName} onJob={setJobSel} /> : <Empty title="Nothing matches" text={actStatus === 'all' ? 'No agent has bought anything yet.' : 'No items with this status.'} action={actStatus === 'all' ? <button className="btn btn-primary !text-sm mt-3" onClick={() => nav('integrate')}>Connect an agent</button> : <button className="btn !text-sm mt-3" onClick={() => setActStatus('all')}>Show everything</button>} />}</div>
            </section>
          </section>

          {/* ---------------------------------------------------------------- agents */}
          <section className="dview" {...hide('agents')}>
            <div className="dhead"><div><h2>Agents</h2><p>An agent is a NEAR account with a spending policy. The API refuses any quote outside it, so the escrow can only be refunded, never paid.</p></div></div>
            <div className="tiles">
              <Tile k="Agents" v={agents.length} s="Registered" />
              <Tile k="Spent, 24h" v={<>{fmtNear(spent24, 3)} <small className="u">NEAR</small></>} s={budget24 ? `of ${fmtNear(budget24, 2)} NEAR budgeted` : 'No budgets set'} />
              <Tile k="Jobs" v={agents.reduce((a, x) => a + (x.usage?.jobs ?? 0), 0)} s="By registered agents" onClick={() => goActivity('all')} />
              <Tile k="Blocked, 24h" v={e24.length} s="Out-of-policy quotes refused" onClick={() => goActivity('blocked')} />
            </div>
            <div className="dgrid fill">
              <section className="dpanel fill">
                <header><h3>Registered agents</h3><span className="muted">Click one for its policy and jobs</span></header>
                <div className="scroll">{agents.length ? (
                  <div className="dtable"><table>
                    <thead><tr><th>Agent</th><th className="num">Per job</th><th>24h budget</th><th className="num">Jobs</th><th className="num">Last job</th></tr></thead>
                    <tbody>{agents.map((a) => {
                      const spent = BigInt(a.usage.spent24hYocto), cap = BigInt(a.policy.dailyCapYocto), pct = cap ? Number((spent * 100n) / cap) : 0;
                      return (
                        <tr key={a.accountId} className="click" onClick={() => setAgentSel(a.accountId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setAgentSel(a.accountId)}>
                          <td data-l="Agent"><b>{a.name}</b><small className="mono">{shortId(a.accountId)}{a.accountId === wallet.accountId ? ' · this browser wallet' : ''}</small></td>
                          <td data-l="Per job" className="num mono">{fmtNear(a.policy.maxPerJobYocto, 3)} N</td>
                          <td data-l="24h budget"><div className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} className={pct > 85 ? 'hot' : ''} /></div><small className="mono">{fmtNear(spent, 3)} / {fmtNear(cap, 3)}</small></td>
                          <td data-l="Jobs" className="num mono">{a.usage.settled}<span className="muted"> / {a.usage.jobs}</span></td>
                          <td data-l="Last job" className="num muted">{ago(a.usage.lastJobAtMs)}</td>
                        </tr>
                      );
                    })}</tbody></table></div>
                ) : <Empty title="No agents yet" text="Register this browser wallet on the right, or an external agent with the SDK or CLI." />}</div>
              </section>
              <section className="dpanel fill">
                <header><h3>{myAgent ? 'This wallet’s policy' : 'Register this browser wallet'}</h3>{myAgent && <span className="dchip good">registered</span>}</header>
                <div className="scroll body space-y-3">
                  <p className="dnote !mt-0">This wallet pays for jobs you run in the Playground. Real agents use their own accounts and register with the SDK or <span className="mono">npm run cli -- agent register</span>.</p>
                  <div><label className="label mb-1.5 block" htmlFor="ag-name">Name</label><input id="ag-name" className="field" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="label mb-1.5 block" htmlFor="ag-job">Per job (NEAR)</label><input id="ag-job" inputMode="decimal" className="field mono" value={form.perJob} onChange={(e) => setForm({ ...form, perJob: e.target.value })} /></div>
                    <div><label className="label mb-1.5 block" htmlFor="ag-day">Daily (NEAR)</label><input id="ag-day" inputMode="decimal" className="field mono" value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} /></div>
                  </div>
                  <div>
                    <div className="label mb-1.5">Allowed offers <span className="normal-case tracking-normal font-medium">(none ticked = all)</span></div>
                    <div className="checks">{market.map((o) => <label key={o.id}><input type="checkbox" checked={form.offers.includes(o.id)} onChange={(e) => setForm({ ...form, offers: e.target.checked ? [...form.offers, o.id] : form.offers.filter((x) => x !== o.id) })} />{o.label} <span className="muted mono">{fmtNear(o.maxCostYoctoNear, 3)} N</span></label>)}</div>
                  </div>
                  <button className="btn btn-primary w-full" onClick={registerThisWallet}>{myAgent ? 'Save policy' : 'Sign and register'}</button>
                  {regMsg && <p className={`dnote !mt-0 ${regMsg.ok ? '!text-ok' : '!text-bad'}`}>{regMsg.text}</p>}
                  <p className="dnote !mt-0">Signed in your browser with this wallet&apos;s key. The API checks the signature and that the key belongs to the account.</p>
                </div>
              </section>
            </div>
          </section>

          {/* ---------------------------------------------------------------- marketplace */}
          <section className="dview" {...hide('marketplace')}>
            <div className="dhead"><div><h2>Marketplace</h2><p>The offers an agent can pick by ID. It pays only on verified proof.</p></div>
              <div className="dseg" role="group" aria-label="Filter">{(['all', 'real', 'demo'] as const).map((f) => <button key={f} className={mkFilter === f ? 'on' : ''} onClick={() => setMkFilter(f)}>{f === 'all' ? 'All' : f === 'real' ? 'Real TEE' : 'Demo'}</button>)}</div></div>
            <div className="scroll fill">
              <div className="mgrid">
                {market.filter((o) => mkFilter === 'all' || o.kind === mkFilter).map((o) => (
                  <article className="mcard" key={o.id}>
                    <div className="mcard-top"><div><h3>{o.label}</h3><span className="mono muted">{o.modelId}</span></div><StatusChip s={o.status} /></div>
                    <div className="mprice"><b>{fmtNear(o.maxCostYoctoNear, 3)}</b><span>NEAR / request</span></div>
                    <div className="mstats">
                      <div><b>{o.stats.jobs}</b><span>jobs</span></div>
                      <div><b>{o.stats.successRate === null ? '·' : `${Math.round(o.stats.successRate * 100)}%`}</b><span>settled</span></div>
                      <div><b>{o.stats.agents}</b><span>agents</span></div>
                    </div>
                    <p className="muted clamp">{o.note}</p>
                    <div className="mmeta"><span className="dchip">{o.kind === 'demo' ? 'demo' : 'real TEE'}</span><span className="dchip">max {Math.round(o.maxInputBytes / 1000)} KB</span></div>
                    <div className="acts"><CopyBtn text={o.id} label="Copy ID" /><button className="btn !text-[13px] !py-1.5 !px-3" disabled={o.status !== 'available'} onClick={() => { setIntOffer(o.id); nav('integrate'); }}>Use in an agent</button></div>
                  </article>
                ))}
                {!market.length && <Empty title="Marketplace unavailable" text="The API did not answer. Check that the backend is running." />}
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------------------- wallet */}
          <section className="dview" {...hide('wallet')}>
            <div className="dhead"><div><h2>Wallet</h2><p>The operator wallet in this browser. It pays for jobs you run from the Playground. External agents use their own NEAR accounts.</p></div><span className="dchip warn">TESTNET ONLY</span></div>
            <div className="tiles three">
              <Tile k="Balance" v={<>{fmtNear(bal, 4)} <small className="u">NEAR</small></>} s="Spendable on testnet" />
              <Tile k="Claimable from escrow" v={<>{fmtNear(claimable, 4)} <small className="u">NEAR</small></>} s="Refunds waiting for you" accent={BigInt(claimable) > 0n} />
              <Tile k="Agent policy" v={myAgent ? 'Registered' : 'None'} s={myAgent ? `${myAgent.name} · ${fmtNear(myAgent.policy.maxPerJobYocto, 3)} N per job` : 'No spending limits on this wallet'} onClick={() => (myAgent ? setAgentSel(myAgent.accountId) : nav('agents'))} />
            </div>
            <div className="dgrid fill">
              <section className="dpanel fill">
                <header><h3>Account</h3><span className="muted">Generated in this browser</span></header>
                <div className="scroll body">
                  <div className="idbox"><span>Account ID</span><code className="mono break">{wallet.accountId}</code></div>
                  <div className="acts"><CopyBtn text={wallet.accountId} label="Copy ID" /><a className="btn !text-[13px] !py-1.5 !px-3" href={`${EXPLORER}/address/${wallet.accountId}`} target="_blank" rel="noreferrer">Open in explorer ↗</a></div>
                  <p className="dnote">The key lives only in this browser. Discarding it forgets this wallet and its remaining test funds. <button className="dlink danger" onClick={() => { if (confirm('Discard this testnet wallet?')) { resetBurner(); location.reload(); } }}>Discard wallet</button></p>
                </div>
              </section>
              <section className="dpanel fill">
                <header><h3>Funds</h3></header>
                <div className="scroll body">
                  <ol className="fundsteps">
                    <li><span>1</span><div><b>Get test NEAR</b><p>1 NEAR from the project faucet, or use a public one.</p>
                      <div className="acts"><button className="btn btn-primary !text-sm" onClick={drip}>+ Get testnet NEAR</button><a className="btn !text-sm" href="https://near-faucet.io" target="_blank" rel="noreferrer">near-faucet.io ↗</a></div></div></li>
                    <li><span>2</span><div><b>Claim refunds</b><p>Money from refused or timed-out jobs waits in the escrow contract until you claim it.</p>
                      <div className="acts"><button className="btn !text-sm" onClick={claim} disabled={BigInt(claimable) === 0n}>{BigInt(claimable) === 0n ? 'Nothing to claim' : `Claim ${fmtNear(claimable, 4)} NEAR`}</button></div></div></li>
                  </ol>
                  {dripMsg && <p className="dnote break">{dripMsg}</p>}
                </div>
              </section>
            </div>
          </section>

          {/* ---------------------------------------------------------------- integrate */}
          <section className="dview" {...hide('integrate')}>
            <div className="dhead"><div><h2>Integrate</h2><p>Agents are the customers. Pick an agent and an offer, then the door your agent speaks. The snippets update.</p></div><a className="btn !text-sm" href="/llms.txt" target="_blank" rel="noreferrer">llms.txt ↗</a></div>
            <div className="pickers">
              <label><span>Agent</span><select className="field" value={intAgent} onChange={(e) => setIntAgent(e.target.value)}><option value="">{myAgent ? `${myAgent.name} (this wallet)` : 'This wallet (not registered)'}</option>{agents.filter((a) => a.accountId !== wallet.accountId).map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}</select></label>
              <label><span>Offer</span><select className="field" value={offerId} onChange={(e) => setIntOffer(e.target.value)}>{market.map((o) => <option key={o.id} value={o.id} disabled={o.status !== 'available'}>{o.label} · {fmtNear(o.maxCostYoctoNear, 3)} N{o.status !== 'available' ? ' · unavailable' : ''}</option>)}</select></label>
            </div>
            <div className="doors">
              {([['sdk', 'TypeScript SDK', 'executePrivateJob()'], ['cli', 'CLI', 'Scripts and cron'], ['mcp', 'MCP tool', 'Any MCP agent'], ['http', 'HTTP API', 'Any language']] as const).map(([k, t, d]) => (
                <button key={k} className={`door ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}><b>{t}</b><span>{d}</span></button>
              ))}
            </div>
            <div className="dgrid fill wide">
              <section className="dpanel fill"><div className="scroll body"><CodeBlock title={tab === 'mcp' ? 'claude_desktop_config.json' : tab === 'sdk' ? 'agent.ts' : tab === 'cli' ? 'shell' : 'curl'} code={SNIP[tab]} /></div></section>
              <section className="dpanel fill"><header><h3>Every job, from the agent&apos;s side</h3></header><div className="scroll body"><ol className="dlist plain num">
                {['Quote. The API sees only public details.', 'Lock the price in the NEAR escrow.', 'Verify the hardware attestation itself.', 'Send the secret encrypted, straight to the verified model.', 'Check the signed answer, submit the public proof.', 'Escrow pays on a signed verdict, or refunds.'].map((x, i) => <li key={x}><span>{i + 1}</span>{x}</li>)}
              </ol><p className="dnote">Then watch it in <button className="dlink" onClick={() => nav('activity')}>Activity</button>. Never: a prompt to the API, a job after a failed attestation, spend outside its policy.</p></div></section>
            </div>
          </section>

          {/* ---------------------------------------------------------------- playground */}
          <section className="dview" {...hide('playground')}>
            <RunJob wallet={wallet} bal={bal} refreshBal={refreshBal} drip={drip} dripMsg={dripMsg} onDone={refreshAll} runAs={runAs} />
          </section>

          {/* ---------------------------------------------------------------- verifier */}
          <section className="dview" {...hide('verifier')}>
            <div className="dhead"><div><h2>Verifier</h2><p>The one explicit trust assumption, and exactly what it checks.</p></div><span className="dchip warn">{policy?.trust?.label ?? 'Trust: CIPHERWORK authorized verifier'}</span></div>
            <div className="tiles">
              <Tile k="Verifier key" v={<span className="mono sm">{ver?.keyId ?? '…'}</span>} s={ver?.algorithm ?? 'ed25519'} />
              <Tile k="Protocol fee" v={`${(ver?.onchain?.fee_bps ?? 500) / 100}%`} s="On success only" />
              <Tile k="Accepted TCB" v={policy?.policy?.acceptedTcbStatuses?.length ?? '·'} s={(policy?.policy?.acceptedTcbStatuses ?? []).join(' · ') || 'policy'} />
              <Tile k="Key timelock" v={`${Math.round((ver?.onchain?.timelock_ms ?? 0) / 1000)}s`} s="Before a new key applies" />
            </div>
            <div className="dgrid fill cols3">
              <section className="dpanel fill"><header><h3>What it checks</h3></header><div className="scroll body"><p className="dtext">{policy?.policy?.description}</p>
                <ul className="dlist">{['Public evidence only, never a prompt or answer', 'Every attestation candidate verifies', 'Signature is provider_tee and matches one attested key', 'Signed text names the model and two SHA-256 hashes'].map((x) => <li key={x}>{x}</li>)}</ul></div></section>
              <section className="dpanel fill"><header><h3>Not verified</h3></header><div className="scroll body"><ul className="dlist bad">{(policy?.policy?.notVerified ?? []).map((x: string) => <li key={x}>{x}</li>)}</ul></div></section>
              <section className="dpanel fill"><header><h3>On-chain config</h3>{ver?.contractId && <a className="dlink" href={`https://testnet.nearblocks.io/address/${ver.contractId}`} target="_blank" rel="noreferrer">Explorer ↗</a>}</header>
                <div className="scroll body kv">{[['Contract', ver?.contractId], ['Domain', ver?.domain], ['Verifier public key', ver?.publicKeyHex], ['Treasury', ver?.onchain?.treasury], ['Owner', ver?.onchain?.owner]].map(([k, v]) => <div key={k as string}><span>{k}</span><b className="mono break">{v ?? '·'}</b></div>)}</div></section>
            </div>
          </section>
        </main>
      </div>
      {jobSel && <JobSheet jobId={jobSel} names={names} offerName={offerName} onClose={() => setJobSel(null)} onAgent={(a) => { setJobSel(null); setAgentSel(a); }} />}
      {mineSheet && <AgentSheet agent={mineSheet} isMine={mineSheet.accountId === wallet.accountId} orders={orders} offerName={offerName} onClose={() => setAgentSel(null)} onJob={(id) => { setAgentSel(null); setJobSel(id); }} onEdit={() => { setForm({ name: mineSheet.name, perJob: fmtNear(mineSheet.policy.maxPerJobYocto, 3), daily: fmtNear(mineSheet.policy.dailyCapYocto, 3), offers: mineSheet.policy.allowedOffers }); setAgentSel(null); nav('agents'); }} />}
    </div>
  );
}

type RunProps = { wallet: { accountId: string; secret: string }; bal: bigint; refreshBal: () => void; drip: () => void; dripMsg: string; onDone: () => void; runAs?: string };
function RunJob({ wallet, bal, refreshBal, drip, dripMsg, onDone, runAs }: RunProps) {
  const [offers, setOffers] = useState<any[]>([]);
  const [offerId, setOfferId] = useState('near-ai-glm-5.3-flash');
  const [input, setInput] = useState(SAMPLE);
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState<'valid' | Exclude<FaultInjection, 'none'>>('valid');
  const [steps, setSteps] = useState(initialSteps());
  const [checks, setChecks] = useState<PreflightCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code: string; message: string } | null>(null);
  const [answer, setAnswer] = useState<string>('');
  const [result, setResult] = useState<PrivateResult | null>(null);
  const [verification, setVerification] = useState<any>(null);
  const [receipt, setReceipt] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [apiBodies, setApiBodies] = useState<{ path: string; bytes: number; preview: string }[]>([]);
  const [claimable, setClaimable] = useState<string>('0');
  const [leak, setLeak] = useState<string>('');
  const [tab, setTab] = useState<'live' | 'answer' | 'receipt' | 'evidence'>('live');
  const abort = useRef(false);
  useNet();

  useEffect(() => { api('/v1/products/private_ai_inference.v1/offers').then((r) => setOffers(r.offers)).catch((e) => setErr({ code: 'PROVIDER_UNAVAILABLE', message: `API unreachable at ${API_URL}: ${e.message}` })); }, []);

  const offer = offers.find((o) => o.id === offerId);
  const inputBytes = useMemo(() => new TextEncoder().encode(input).length, [input]);
  const setStep = (id: StepId, s: StepState) => setSteps((p) => ({ ...p, [id]: s }));
  const inferencePosts = netLog.filter((n) => n.kind === 'near-ai-inference' && n.method === 'POST').length;
  const apiPosts = netLog.filter((n) => n.kind === 'cipherwork-api' && n.method === 'POST');

  async function post(path: string, body: unknown) {
    const s = JSON.stringify(body);
    setApiBodies((p) => [...p, { path, bytes: new TextEncoder().encode(s).length, preview: s.length > 420 ? s.slice(0, 420) + ' … (public attestation evidence truncated)' : s }]);
    return { s, res: await api(path, { method: 'POST', body: s }) };
  }

  function leakCheck(bodies: string[]) {
    const shingles: string[] = [];
    for (let i = 0; i + 24 <= input.length && shingles.length < 400; i += 11) shingles.push(input.slice(i, i + 24));
    const hit = bodies.filter((b) => shingles.some((sh) => b.includes(sh))).length;
    setLeak(`${hit} of ${bodies.length} API request bodies contain any of ${shingles.length} sampled 24-character fragments of your input.`);
  }

  async function run() {
    abort.current = false; setBusy(true); setErr(null); setAnswer(''); setResult(null); setVerification(null); setReceipt(null); setChecks([]); setLeak('');
    setSteps(initialSteps()); setApiBodies([]); clearNet();
    const bodies: string[] = [];
    const keep = async (path: string, body: unknown) => { const r = await post(path, body); bodies.push(r.s); return r.res; };
    let jobId = ''; let funded = false;
    try {
      if (!offer || offer.status !== 'available') throw Object.assign(new Error(`${offer?.label ?? 'Offer'} is ${offer?.status ?? 'unknown'}`), { code: 'PROVIDER_UNAVAILABLE' });
      if (inputBytes === 0 || inputBytes > offer.maxInputBytes) throw Object.assign(new Error(`Input must be 1..${offer.maxInputBytes} bytes`), { code: 'MODEL_NOT_ALLOWED' });
      if (mode === 'valid' && !apiKey.trim()) throw Object.assign(new Error('Paste your NEAR AI Cloud API key (kept in memory only).'), { code: 'PAYMENT_FAILED' });
      setStep('draft', 'done'); setStep('quote', 'active');
      const q = await keep('/v1/quotes', { productId: 'private_ai_inference.v1', offerId, buyerAccountId: wallet.accountId });
      setQuote(q.quote); setStep('quote', 'done');
      const need = BigInt(q.quote.depositYoctoNear) + 5n * 10n ** 22n;
      const have = await balanceYocto(wallet.accountId);
      if (have < need) throw Object.assign(new Error(`Burner wallet needs ≥ ${fmtNear(need)} NEAR (has ${fmtNear(have)}). Use "Get testnet NEAR".`), { code: 'PAYMENT_FAILED' });

      setStep('fund', 'active');
      const res: any = await account(wallet).callFunctionRaw({
        contractId: q.quote.escrowContractId, methodName: 'create_order',
        args: { order_id: q.quote.jobId, provider_id: q.quote.providerAccountId, deadline_ms: q.quote.deadlineMs, quote_digest: q.quote.quoteDigest },
        deposit: BigInt(q.quote.depositYoctoNear), gas: 60_000_000_000_000n,
      });
      jobId = q.quote.jobId; funded = true;
      const created = await keep('/v1/orders', { jobId, quoteId: q.quote.quoteId, fundTxHash: res.transaction.hash });
      setReceipt(created.receipt); setStep('fund', 'done'); refreshBal();

      setStep('preflight', 'active');
      let pf: Preflight;
      try {
        pf = await preflight(sdk as any, { baseUrl: NEAR_AI, model: offer.modelId, fault: mode === 'valid' ? 'none' : mode, gpu: GPU_RELAY, onCheck: (c) => setChecks((p) => [...p, c]) });
      } catch (e: any) {
        if (!(e instanceof PreflightError)) throw e;
        setChecks(e.checks); setStep('preflight', 'failed');
        setErr({ code: e.code, message: `${ERR_TEXT[e.code]} (${e.message.slice(0, 200)})` });
        // Request an independent refund verdict: the verifier must reproduce the failure itself.
        if (e.attestations.length) {
          setStep('settle', 'active');
          try {
            const bundle = { jobId, offerId, model: offer.modelId, preflight: { nonce: e.nonce, attestations: e.attestations, performedAtMs: Date.now() },
              completion: { completionId: 'none-preflight-blocked', signature: { kind: 'provider_tee', signer: e.attestations[0].signer, signedText: `${offer.modelId}:${'0'.repeat(64)}:${'0'.repeat(64)}`, signature: '0'.repeat(128) } } };
            const r = await keep(`/v1/orders/${jobId}/reject`, { reason: 'ATTESTATION_INVALID', bundle });
            setReceipt(r.receipt); setVerification(r.verification); setStep('settle', 'done'); setStep('receipt', 'done');
            setClaimable(await contractView<string>(q.quote.escrowContractId, 'get_balance', { account_id: wallet.accountId }));
          } catch (e2: any) { setStep('settle', 'failed'); setErr({ code: e2.code ?? 'VERIFIER_REJECTED', message: e2.message }); }
        }
        leakCheck(bodies);
        return;
      }
      setStep('preflight', 'done');

      setStep('execute', 'active');
      const out = await runPrivateInference(sdk, {
        baseUrl: NEAR_AI, apiKey: apiKey.trim(), model: offer.modelId, preflight: pf, gpu: GPU_RELAY,
        messages: [{ role: 'system', content: 'You are a careful financial analyst. Be concise.' }, { role: 'user', content: `Analyse this confidential report. List the main risks and the cash headroom over the covenant.\n\n${input}` }],
      });
      setAnswer(out.answer); setResult(out); setStep('execute', 'done');
      setStep('verify', out.signatureKind === 'provider_tee' && out.signerMatchesPreflight ? 'done' : 'failed');

      setStep('settle', 'active');
      const proof = await keep(`/v1/orders/${jobId}/proof`, buildProofBundle({ jobId, offerId, model: offer.modelId, preflight: pf, result: out }));
      setReceipt(proof.receipt); setVerification(proof.verification);
      setStep('settle', proof.verification?.ok ? 'done' : 'failed'); setStep('receipt', 'done');
      if (!proof.verification?.ok) setErr({ code: proof.verification?.failureCode ?? 'VERIFIER_REJECTED', message: ERR_TEXT[proof.verification?.failureCode ?? 'VERIFIER_REJECTED'] });
      leakCheck(bodies);
    } catch (e: any) {
      const code = e.code && ERR_TEXT[e.code] ? e.code : e.status === 401 || e.status === 403 ? 'PAYMENT_FAILED' : 'PROVIDER_UNAVAILABLE';
      setErr({ code, message: `${ERR_TEXT[code]} ${String(e.message ?? e).slice(0, 300)}` });
      setSteps((p) => { const n = { ...p }; const a = STEPS.find((s) => n[s.id] === 'active'); if (a) n[a.id] = 'failed'; return n; });
      if (funded) leakCheck(bodies);
    } finally { setBusy(false); refreshBal(); onDone(); }
  }

  async function claim() {
    try {
      await account(wallet).callFunctionRaw({ contractId: quote.escrowContractId, methodName: 'claim_balance', args: {}, gas: 60_000_000_000_000n });
      setClaimable('0'); setTimeout(refreshBal, 2500);
    } catch (e: any) { setErr({ code: 'PAYMENT_FAILED', message: e.message }); }
  }

  function reset() {
    setInput(SAMPLE); setAnswer(''); setResult(null); setVerification(null); setReceipt(null); setChecks([]); setErr(null); setSteps(initialSteps()); setApiBodies([]); setLeak(''); clearNet(); setMode('valid');
  }

  const kb = (n: number) => (n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
  const outcome = receipt?.status === 'settled' ? 'settled' : receipt?.status === 'rejected' ? 'rejected' : null;
  const nPass = steps.preflight === 'failed' ? checks.length : steps.preflight === 'done' || steps.execute !== 'idle' ? 6 : Math.min(6, checks.length);
  useEffect(() => { if (answer) setTab('answer'); }, [answer]);
  useEffect(() => { if (busy) setTab('live'); }, [busy]);
  const tabs: [typeof tab, string, boolean][] = [['live', 'Live', true], ['answer', 'Answer', !!answer], ['receipt', 'Receipt', !!receipt], ['evidence', 'Evidence', checks.length > 0 || !!verification]];
  return (
    <>
      <div className="dhead">
        <div><h2>Playground</h2><p>Run one job by hand to see the protocol. Real agents use the SDK, CLI or MCP tool, never a form.</p></div>
        <div className="dhead-chips"><span className="dchip info">Escrow {offer ? `${fmtNear(offer.maxCostYoctoNear, 3)} NEAR` : '·'}</span><span className="dchip">Wallet {fmtNear(bal, 3)} NEAR</span>{runAs && <span className="dchip warn" title="The spending policy of this wallet applies to every quote">Running as {runAs}</span>}</div>
      </div>
      <div className="drun fill">
        <div className="dcol scroll">
          {err && (
            <div role="alert" className="dalert">
              <div className="flex items-center gap-2 mb-1 flex-wrap"><span className="dchip bad">{err.code}</span><b>Stopped, fail closed</b></div>
              <p>{err.message}</p>
              {steps.preflight === 'failed' && <p className="mt-2">Secret bytes sent to any inference endpoint: <b className="mono text-ok">{inferencePosts === 0 ? '0' : inferencePosts}</b>. Payout to provider: <b>none</b>.</p>}
            </div>
          )}
          <section className="dpanel">
            <header><h3><span className="dstep">1</span>Vault</h3></header>
            <div className="body !py-3">
              <div className="offers" role="radiogroup" aria-label="Vault">
                {offers.map((o) => (
                  <button key={o.id} role="radio" aria-checked={offerId === o.id} onClick={() => setOfferId(o.id)} disabled={busy} className={`offer ${offerId === o.id ? 'on' : ''}`} title={o.note}>
                    <b>{o.label}</b>
                    <span className="offer-meta mono">{fmtNear(o.maxCostYoctoNear, 3)} N</span>
                    <span className={`dchip ${o.status === 'available' ? 'good' : 'bad'}`}>{o.status === 'available' ? 'open' : 'closed'}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="dpanel">
            <header><h3><span className="dstep">2</span>Secret</h3><button className="dlink" onClick={reset} disabled={busy}>Reset to sample</button></header>
            <div className="body !py-3">
              <textarea id="input" aria-label="Secret" className="field mono text-xs leading-relaxed h-24" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} disabled={busy} />
              <div className="dnote !mt-1.5">{kb(inputBytes)} · fictional sample · memory only, never sent to this app&apos;s API</div>
            </div>
          </section>
          <section className="dpanel">
            <header><h3><span className="dstep">3</span>Run</h3></header>
            <div className="body !py-3 space-y-3">
              <input id="key" type="password" autoComplete="off" aria-label="NEAR AI Cloud key" className="field mono" placeholder="NEAR AI Cloud key (sk-…)  ·  stays in this tab" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} />
              <fieldset className="dseg wide" disabled={busy}>
                <legend className="sr-only">Scenario</legend>
                {([['valid', 'Happy path'], ['tampered_quote', 'Tampered quote'], ['wrong_nonce', 'Replayed nonce']] as const).map(([m, l]) => <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={mode === m ? 'on' : ''}>{l}</button>)}
              </fieldset>
              {mode !== 'valid' && <p className="dnote !mt-0 !text-warn">Test fixture: deliberately forged evidence. Not a real attack.</p>}
              <button className={`btn ${mode === 'valid' ? 'btn-primary' : 'btn-danger'} lg w-full`} onClick={run} disabled={busy || !offer}>
                {busy ? <><span className="spinner" /> Working…</> : mode === 'valid' ? 'Send it privately' : 'Run the forged-proof test'}
              </button>
              {(dripMsg || bal < 3n * 10n ** 22n) && <p className="dnote !mt-0 break">{dripMsg || <>Low balance. <button className="dlink" onClick={drip}>Get 1 testnet NEAR</button></>}</p>}
            </div>
          </section>
        </div>

        <section className="dpanel fill rightpanel">
          <header className="tabsbar">
            <div className="dseg" role="tablist" aria-label="Job output">{tabs.map(([k, l, on]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} disabled={!on} onClick={() => setTab(k)}>{l}</button>)}</div>
            <span className="muted">{busy ? 'Running' : 'Idle'}</span>
          </header>
          <div className="scroll body">
            {tab === 'live' && (<>
              <Stage steps={steps as any} checks={checks} outcome={outcome} running={busy} />
              <div className="mt-3"><Stepper steps={steps as any} /></div>
              <Checklist className="dchecks inline" nPass={nPass} failed={steps.preflight === 'failed'} />
            </>)}
            {tab === 'answer' && (<>
              <pre className="answer">{answer}</pre>
              <p className="dnote">Only in this tab&apos;s memory. It disappears on reload. <button className="dlink" onClick={() => { setAnswer(''); setTab('live'); }}>Clear</button></p>
            </>)}
            {tab === 'receipt' && receipt && (<>
              <div className="flex items-center gap-3 mb-4"><StatusChip s={receipt.status} /><span className="muted mono">{shortId(receipt.jobId)}</span></div>
              <div className="kv two">
                <div><span>Escrowed</span><b className="mono">{fmtNear(receipt.amountYoctoNear)} NEAR</b></div>
                <div><span>Protocol fee</span><b className="mono">{receipt.protocolFeeYoctoNear ? `${fmtNear(receipt.protocolFeeYoctoNear, 6)} NEAR` : '·'}</b></div>
                <div><span>Proof digest</span><b className="mono break">{receipt.proofDigest ? shortId(receipt.proofDigest) : '·'}</b></div>
                <div><span>Trust</span><b>{receipt.trust}</b></div>
              </div>
              <div className="acts">
                {receipt.fundTxUrl && <a className="btn !text-sm" href={receipt.fundTxUrl} target="_blank" rel="noreferrer">Funding tx ↗</a>}
                {receipt.settleTxUrl && <a className="btn !text-sm" href={receipt.settleTxUrl} target="_blank" rel="noreferrer">Settlement tx ↗</a>}
                <button className="btn !text-sm" onClick={() => { const blob = new Blob([JSON.stringify({ receipt, checks: verification?.checks ?? [], note: 'Sanitized public proof. Contains no prompt or answer.' }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cipherwork-proof-${receipt.jobId}.json`; a.click(); }}>Export proof JSON</button>
                {BigInt(claimable) > 0n && <button className="btn btn-primary !text-sm" onClick={claim}>Take {fmtNear(claimable)} NEAR back</button>}
              </div>
            </>)}
            {tab === 'evidence' && (<div className="space-y-6">
              <div>
                <div className="label mb-2">Verification checks</div>
                <ul className="dlist plain">
                  {checks.map((c, i) => <li key={i} className="flex gap-3 items-start"><Badge s={c.status} /><div className="min-w-0"><div className="text-sm">{c.label}</div>{c.detail && <div className="text-xs text-mute mono break-words mt-0.5">{c.detail}</div>}</div></li>)}
                  {result && (<>
                    <li className="flex gap-3 items-start"><Badge s={result.signatureKind === 'provider_tee' ? 'passed' : 'failed'} /><div className="text-sm">Response signature over exact bytes <span className="text-xs text-mute mono">({result.signatureKind})</span></div></li>
                    <li className="flex gap-3 items-start"><Badge s={result.signerMatchesPreflight ? 'passed' : 'failed'} /><div className="text-sm">Signer equals the key attested in preflight</div></li>
                    <li className="flex gap-3 items-start"><Badge s="passed" /><div className="text-sm">Request fields end-to-end encrypted to the attested model key</div></li>
                  </>)}
                  {verification?.checks?.map((c: any) => <li key={c.id} className="flex gap-3 items-start"><Badge s={c.status} /><div className="min-w-0"><div className="text-sm"><span className="text-mute">Verifier · </span>{c.label}</div>{c.detail && <div className="text-xs text-mute mono break-words mt-0.5">{String(c.detail).slice(0, 300)}</div>}</div></li>)}
                </ul>
              </div>
              <div>
                <div className="label mb-2">Where did the data go?</div>
                <div className="kv two">
                  <div><span>Plaintext to API</span><b className="mono text-ok">0 B</b></div>
                  <div><span>Inference POSTs to TEE</span><b className="mono">{inferencePosts}</b></div>
                  <div><span>API POST requests</span><b className="mono">{apiPosts.length}</b></div>
                </div>
                {leak && <p className="dnote">{leak}</p>}
                <ul className="reqlog mono">{netLog.filter((n) => n.kind !== 'other').slice(-8).map((n, i) => <li key={i} className={n.kind === 'near-ai-inference' ? 'hot' : ''}>{n.method} {n.host.replace('cloud-api.', '')}{n.path.slice(0, 26)} {n.bytes ? kb(n.bytes) : ''}</li>)}</ul>
              </div>
              <div>
                <div className="label mb-2">Public payloads the API received</div>
                {apiBodies.length === 0 && <p className="dnote !mt-0">Nothing yet.</p>}
                <ul className="space-y-2">{apiBodies.map((b, i) => <li key={i} className="text-xs"><div className="mono text-accent font-bold">POST {b.path} · {kb(b.bytes)}</div><pre className="mono text-mute whitespace-pre-wrap break-all">{b.preview}</pre></li>)}</ul>
              </div>
            </div>)}
          </div>
        </section>
      </div>
    </>
  );
}

function Dots({ steps }: { steps: Record<StepId, StepState> }) {
  return (
    <ol className="flex flex-wrap justify-center gap-x-1 gap-y-2 text-xs font-semibold" aria-label="Progress">
      {STEPS.map((s, i) => {
        const st = steps[s.id];
        const bg = st === 'done' ? 'bg-ok text-ink' : st === 'failed' ? 'bg-bad text-ink' : st === 'active' ? 'bg-accent text-white' : 'bg-panel-2';
        return (<li key={s.id} className="flex items-center gap-1"><span className={`px-3 py-1 rounded-full border border-line ${bg}`}>{st === 'done' ? '✓ ' : st === 'failed' ? '✕ ' : ''}{s.label}</span>{i < STEPS.length - 1 && <span className="text-mute">›</span>}</li>);
      })}
    </ol>
  );
}

function Row({ k, v, mono }: { k: string; v: any; mono?: boolean }) {
  return <div className="min-w-0"><dt className="label">{k}</dt><dd className={`break-all ${mono ? 'mono text-xs' : ''}`}>{v}</dd></div>;
}

/* ------------------------------------------------------------------ Model */
function Model() {
  const [policy, setPolicy] = useState<any>(null);
  const [ver, setVer] = useState<any>(null);
  useEffect(() => { api('/v1/proof-policy/near-ai-cloud-tdx-v1').then(setPolicy).catch(() => {}); api('/v1/verifier').then(setVer).catch(() => {}); }, []);
  const L = ({ t, items }: { t: string; items: string[] }) => (<div><h3>{t}</h3><ul className="trust-checks">{items.map((x, i) => <li key={x}><span className="trust-check-index">{String(i + 1).padStart(2, '0')}</span><span>{x}</span></li>)}</ul></div>);
  return (
    <div className="knowledge-page verification-page">
      <section className="knowledge-hero">
        <div className="knowledge-intro"><span className="eyebrow">THE TRUST LAB &middot; VERIFICATION</span><h1>Trust has to<br /><em>show its work.</em></h1><p>Before a secret moves, the hardware proves itself. Before money moves, the evidence gets checked again.</p><div className="knowledge-actions"><a className="btn btn-primary lg" href="#console/playground">Test a private job &#8599;</a><a className="knowledge-link" href="#dev">Explore the API &#8599;</a></div><span className="knowledge-footnote">NEAR testnet &middot; Explicit checks. Explicit limits.</span></div>
        <div className="trust-art" aria-label="Hardware evidence is checked before encrypted input is sent"><div className="trust-orbit" /><img src="/assets/how-it-works/vault.png" alt="" width="1254" height="1254" /><span className="art-note note-top"><LaneIcon name="proof" /> Verify first</span><span className="art-note note-bottom"><LaneIcon name="secret" /> Then send the secret</span></div>
      </section>
      <ol className="proof-ribbon" aria-label="Verification sequence">{[['vault', 'Hardware', 'Fresh attestation'], ['secret', 'Private input', 'Encrypted to the key'], ['proof', 'Signed answer', 'Exact bytes checked'], ['chain', 'Settlement', 'Verdict verified on-chain']].map(([icon, title, detail], i) => <li key={title}><LaneIcon name={icon as LaneIconName} /><div><small>0{i + 1}</small><strong>{title}</strong><span>{detail}</span></div></li>)}</ol>
      <div className="knowledge-section-heading"><span className="eyebrow">UNDER THE HOOD</span><h2>Every check has a purpose.</h2><p>These are the checks in the flow, not a live verification result.</p></div>
      <div className="trust-grid">
        <div className="trust-panel"><span className="trust-panel-label"><LaneIcon name="vault" /> 01 / BEFORE EXECUTION</span><L t="Verified before any input leaves the client" items={[
          'Fresh 256-bit client nonce, echoed by the report and bound inside the Intel TDX quote',
          'Intel TDX quote verified with DCAP collateral; TCB status policy; debug mode off',
          'Signing key bound to the quote report data',
          'RTMR3 event-log replay and MRCONFIGID = SHA-256(app_compose)',
          'NVIDIA GPU evidence via NRAS when present',
          'Request fields E2EE-encrypted to the attested model key',
        ]} /></div>
        <div className="trust-panel"><span className="trust-panel-label"><LaneIcon name="proof" /> 02 / AFTER EXECUTION</span><L t="Verified after the response" items={[
          'Response signature over the exact request/response bytes (SDK, client side)',
          'Signer equals exactly one attested model report from this job',
          'Independent verifier re-checks the public evidence and signature, then signs a verdict',
          'Contract checks the verifier signature, contract ID, chain, order, expiry, replay',
        ]} /></div>
        <div className="trust-panel trust-limits"><span className="trust-panel-label"><LaneIcon name="no" /> THE BOUNDARY</span><L t="Not verified / not claimed" items={[
          'Correctness of the model answer',
          'Provider data retention (documented, not technically verifiable)',
          'That the attested instance is the one serving this exact request (instances share one signing key)',
          'Gateway TLS binding in the browser (browser fetch cannot read the peer certificate; the Node CLI/SDK does)',
          'Private payments: NEAR transactions are public',
        ]} /></div>
        <div className="trust-panel trust-assumptions"><span className="trust-panel-label"><LaneIcon name="chain" /> THE PEOPLE & SYSTEMS</span><L t="Trust assumptions" items={[
          'Intel / NVIDIA hardware roots and TEE firmware',
          'NEAR AI Cloud as operator of the models',
          'CIPHERWORK authorized verifier key for settlement (the contract does not verify TDX on-chain)',
          'Your own browser and OS',
        ]} /></div>
      </div>
      <div className="trust-identity"><div className="knowledge-section-heading"><span className="eyebrow">PUBLIC IDENTITY</span><h2>Know who signs the verdict.</h2></div>
        <span className="badge badge-na">{policy?.trust?.label ?? 'Trust: CIPHERWORK authorized verifier'}</span>
        <p className="text-sm text-mute mt-3">{policy?.trust?.text}</p>
        {!ver && <p className="text-sm text-mute mt-4">Verifier details are loading or unavailable. No live identity has been confirmed here yet.</p>}
        {ver && <dl className="mt-4 grid sm:grid-cols-2 gap-3 text-sm"><Row k="Verifier key ID" v={ver.keyId} mono /><Row k="Verifier public key" v={ver.publicKeyHex} mono /><Row k="Domain" v={ver.domain} mono /><Row k="Escrow contract" v={ver.contractId} mono /></dl>}
      </div>
      {policy?.policy && <details className="trust-policy"><summary className="cursor-pointer font-semibold">Policy JSON: {policy.policy.id}</summary><pre className="mono text-xs mt-3 whitespace-pre-wrap text-mute">{JSON.stringify(policy.policy, null, 2)}</pre></details>}
    </div>
  );
}

/* ------------------------------------------------------------------ Dev */
function Dev() {
  const [selected, setSelected] = useState(3);
  const examples = [
    { title: 'Discover offers', code: `curl ${API_URL}/v1/products/private_ai_inference.v1/offers` },
    { title: 'Quote (public parameters only)', code: `curl -X POST ${API_URL}/v1/quotes -H 'content-type: application/json' \\\n  -d '{"productId":"private_ai_inference.v1","offerId":"near-ai-glm-5.3-flash","buyerAccountId":"<you>.testnet"}'` },
    { title: 'Leak guard (expect 400 PRIVATE_FIELD_REJECTED)', code: `curl -X POST ${API_URL}/v1/quotes -H 'content-type: application/json' -d '{"prompt":"secret"}'` },
    { title: 'TypeScript SDK (Node)', code: `import { CipherworkClient } from './sdk';\nconst c = new CipherworkClient({\n  apiUrl: '${API_URL}',\n  nearAiApiKey: process.env.NEARAI_API_KEY,      // goes only to cloud-api.near.ai\n  buyerAccountId: process.env.BUYER_ACCOUNT,\n  buyerPrivateKey: process.env.BUYER_KEY,\n});\nconst out = await c.executePrivateJob({\n  offerId: 'near-ai-glm-5.3-flash',\n  messages: [{ role: 'user', content: 'Summarise: …' }],\n});\nconsole.log(out.answer, out.settled.receipt);` }
  ];
  const current = examples[selected];
  const endpoints = `GET  /health\nGET  /v1/products\nGET  /v1/products/{productId}/offers\nPOST /v1/quotes\nPOST /v1/orders\nGET  /v1/orders/{jobId}\nPOST /v1/orders/{jobId}/proof     (public evidence bundle → verifier verdict → on-chain settle)\nPOST /v1/orders/{jobId}/reject    (client-reported failure; verifier must reproduce it)\nGET  /v1/proof-policy/{id}\nGET  /v1/receipts/{jobId}\nGET  /v1/verifier`.split('\n');
  return <div className="knowledge-page developer-page">
    <section className="knowledge-hero dev-hero">
      <div className="knowledge-intro"><span className="eyebrow">THE BUILD ROOM &middot; DEVELOPERS</span><h1>A private job.<br /><em>A few lines away.</em></h1><p>Give your agent verified compute and settlement on NEAR. The SDK handles the private flow; the marketplace handles public metadata.</p><div className="knowledge-actions"><a className="btn btn-primary lg" href="#console/integrate">Open integrations &#8599;</a><a className="knowledge-link" href="#model">Understand the trust model &#8599;</a></div><span className="knowledge-footnote">Node SDK &middot; HTTP API &middot; NEAR testnet</span></div>
      <div className="dev-hero-art"><span className="floating-code" aria-hidden="true">{'{ }'}</span><img src="/assets/receipt-guardian.png" alt="" width="1254" height="1254" /><span className="art-note"><LaneIcon name="secret" /> Your secret takes a private route.</span></div>
    </section>
    <div className="api-address"><div><span className="api-dot" /><span className="mono">API BASE</span><code>{API_URL}</code></div><CopyBtn text={API_URL} label="Copy URL" /></div>
    <section className="developer-workbench" aria-labelledby="quickstart-title">
      <div className="developer-sidebar"><span className="eyebrow">START BUILDING</span><h2 id="quickstart-title">Pick your<br />entry point.</h2><p>Real request shapes, ready to copy. Replace the account placeholders and configure your own credentials.</p><div className="code-selector" role="group" aria-label="Code example">{examples.map((example, i) => <button key={example.title} aria-pressed={selected === i} onClick={() => setSelected(i)}><span>0{i + 1}</span>{['Discover offers', 'Request a quote', 'Test the leak guard', 'Run with TypeScript'][i]}<b aria-hidden="true">&#8599;</b></button>)}</div></div>
      <div className="developer-editor"><div className="editor-title"><span className="editor-lights" aria-hidden="true"><i /><i /><i /></span><span>{selected === 3 ? 'private-job.ts' : 'terminal.sh'}</span><CopyBtn text={current.code} label="Copy code" /></div><div className="editor-description">{current.title}</div><pre tabIndex={0} aria-label={current.title}><code>{current.code}</code></pre><div className="editor-note"><LaneIcon name={selected === 2 ? 'no' : 'secret'} /><span>{selected === 2 ? 'Expected: 400 PRIVATE_FIELD_REJECTED. This deliberately tests the API boundary.' : selected === 3 ? "Run from the backend project with its local SDK. Credentials stay in environment variables." : 'Public metadata only. Never include your prompt or secret in marketplace requests.'}</span></div></div>
    </section>
    <section className="dev-boundary"><LaneIcon name="secret" /><div><h3>The API never needs your secret.</h3><p>Prompt-like fields are rejected with 400. Private input goes directly to verified hardware, encrypted to its attested key.</p></div><a href="#model">See what is verified &#8599;</a></section>
    <section className="endpoint-section"><div className="knowledge-section-heading"><span className="eyebrow">THE PUBLIC SURFACE</span><h2>Small API. Clear responsibilities.</h2><p>Discover, fund, submit evidence and inspect the receipt.</p></div><div className="endpoint-list">{endpoints.map(line => { const match = line.match(/^(GET|POST)\s+(\S+)\s*(.*)$/); if (!match) return null; return <div className="endpoint-row" key={line}><span className={`endpoint-method ${match[1] === 'POST' ? 'post' : ''}`}>{match[1]}</span><code>{match[2]}</code>{match[3] && <span className="endpoint-detail">{match[3]}</span>}<CopyBtn text={`${API_URL}${match[2]}`} label="Copy path" /></div>; })}</div></section>
    <div className="knowledge-outro"><div><span className="eyebrow">FROM CODE TO PROOF</span><h2>See the whole flow in action.</h2></div><a className="btn btn-primary lg" href="#console/playground">Open the live demo &#8599;</a></div>
  </div>;
}
