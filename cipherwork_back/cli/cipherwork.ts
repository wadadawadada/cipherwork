#!/usr/bin/env tsx
/** CIPHERWORK CLI. Usage: pnpm cli -- <discover|verify <model>|quote <offer>|run <offer> <file>> */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { CipherworkClient } from '../sdk/index.js';

const [cmd, a, b] = process.argv.slice(2);
const c = new CipherworkClient({
  apiUrl: process.env.API_URL ?? 'http://localhost:8787', nearAiApiKey: process.env.NEARAI_API_KEY,
  buyerAccountId: process.env.DEMO_BUYER_ACCOUNT_ID, buyerPrivateKey: process.env.DEMO_BUYER_PRIVATE_KEY,
  onEvent: (e) => console.error(`[${e.step}] ${e.detail ?? ''}`),
});
try {
  if (cmd === 'discover') console.log(JSON.stringify(await c.discover(), null, 2));
  else if (cmd === 'verify' && a) { const p = await c.verifyProvider(a); console.log(JSON.stringify(p.checks, null, 2)); }
  else if (cmd === 'agent' && a === 'register' && b) { const [name, perJob, daily] = b.split(','); const N = 10n ** 24n; const r = await c.registerAgent({ name, maxPerJobYocto: (BigInt(Math.round(Number(perJob) * 1000)) * N / 1000n).toString(), dailyCapYocto: (BigInt(Math.round(Number(daily) * 1000)) * N / 1000n).toString() }); console.log(JSON.stringify(r, null, 2)); }
  else if (cmd === 'quote' && a) console.log(JSON.stringify(await c.quote(a), null, 2));
  else if (cmd === 'run' && a && b) {
    const o = await c.executePrivateJob({ offerId: a, messages: [{ role: 'user', content: readFileSync(b, 'utf8') }] });
    console.log(o.answer); console.error(JSON.stringify(o.settled.receipt, null, 2));
  } else console.log('usage: cli discover | verify <model> | quote <offerId> | run <offerId> <file> | agent register <name,perJobNEAR,dailyNEAR>');
} catch (e: any) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exit(1); }
