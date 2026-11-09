import { Buffer } from 'buffer';
(globalThis as any).Buffer ??= Buffer;
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
