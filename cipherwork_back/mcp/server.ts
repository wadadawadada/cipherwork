#!/usr/bin/env tsx
/**
 * CIPHERWORK MCP server (stdio). Lets any MCP-capable agent buy confidential inference.
 *
 * Privacy: the prompt goes from THIS local process straight to the attested NEAR AI Cloud model
 * (E2EE, only after the hardware preflight passes). It never goes through the CIPHERWORK API.
 *
 * Env: API_URL, NEARAI_API_KEY, BUYER_ACCOUNT_ID, BUYER_PRIVATE_KEY (the agent's own NEAR testnet key).
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CipherworkClient } from '../sdk/index.js';

const client = new CipherworkClient({
  apiUrl: process.env.API_URL ?? 'http://localhost:8787',
  nearAiApiKey: process.env.NEARAI_API_KEY,
  buyerAccountId: process.env.BUYER_ACCOUNT_ID ?? process.env.DEMO_BUYER_ACCOUNT_ID,
  buyerPrivateKey: process.env.BUYER_PRIVATE_KEY ?? process.env.DEMO_BUYER_PRIVATE_KEY,
});

const server = new McpServer({ name: 'cipherwork', version: '0.1.0' });
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (e: any) => ({ isError: true, content: [{ type: 'text' as const, text: `${e?.code ?? 'ERROR'}: ${e?.message ?? e}` }] });

server.registerTool('cipherwork_list_offers', {
  title: 'List confidential compute offers',
  description: 'Lists private AI inference offers (model, price in NEAR, live availability, success rate). Public metadata only.',
  inputSchema: {},
}, async () => {
  try {
    const r: any = await fetch(`${process.env.API_URL ?? 'http://localhost:8787'}/v1/marketplace`).then((x) => x.json());
    return text(JSON.stringify(r.offers.map((o: any) => ({ id: o.id, label: o.label, model: o.modelId, status: o.status, kind: o.kind, priceYoctoNear: o.maxCostYoctoNear, stats: o.stats, note: o.note })), null, 2));
  } catch (e) { return fail(e); }
});

server.registerTool('cipherwork_run_private_job', {
  title: 'Run a private AI job',
  description: 'Buys one confidential inference: verifies the hardware attestation BEFORE sending anything, sends the prompt encrypted straight to the attested model, verifies the signed answer and settles the escrow on NEAR testnet. Fails closed if verification fails. Returns the answer and a public receipt (no prompt, no answer in the receipt).',
  inputSchema: {
    offerId: z.string().describe('Offer id from cipherwork_list_offers, e.g. near-ai-glm-5.3-flash'),
    prompt: z.string().min(1).max(30000).describe('The confidential input. It is sent only to the verified hardware.'),
    system: z.string().max(2000).optional().describe('Optional system instruction'),
  },
}, async ({ offerId, prompt, system }) => {
  try {
    const out = await client.executePrivateJob({ offerId, messages: [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user' as const, content: prompt }] });
    const r = out.settled.receipt;
    return text(`${out.answer}\n\n---\nreceipt: job ${r.jobId} · ${r.status} · escrow ${r.amountYoctoNear} yoctoNEAR · proof ${r.proofDigest}\nsettlement: ${r.settleTxUrl}`);
  } catch (e) { return fail(e); }
});

server.registerTool('cipherwork_get_receipt', {
  title: 'Get a public receipt',
  description: 'Returns the sanitized public receipt of a job (status, amounts, proof digest, transaction links).',
  inputSchema: { jobId: z.string() },
}, async ({ jobId }) => {
  try { return text(JSON.stringify(await client.getReceipt(jobId), null, 2)); } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
