import { buildApp } from './app.js';
import { config } from './config.js';
import { createStore } from './store.js';

const store = createStore();
await store.init();
const app = await buildApp(store);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ store: store.kind, escrow: config.ESCROW_CONTRACT_ID }, 'CIPHERWORK API ready');
