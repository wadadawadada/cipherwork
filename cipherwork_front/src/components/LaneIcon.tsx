import type { ReactNode } from 'react';

export type LaneIconName = 'information' | 'marketplace' | 'vault' | 'chain' | 'secret' | 'price' | 'proof' | 'receipt' | 'yes' | 'no' | 'mid';

const shapes: Record<LaneIconName, ReactNode> = {
  information: <><rect x="5" y="3" width="16" height="22" rx="5" fill="currentColor" fillOpacity=".10" /><path d="M10 9h6M10 14h6M10 19h3" /></>,
  marketplace: <><rect x="3" y="4" width="22" height="20" rx="6" fill="currentColor" fillOpacity=".10" /><path d="M8 9h6l6 5-6 5H8V9Z" /><circle cx="11" cy="14" r="1" fill="currentColor" stroke="none" /></>,
  vault: <><rect x="3" y="3" width="22" height="22" rx="7" fill="currentColor" fillOpacity=".10" /><rect x="7" y="7" width="14" height="14" rx="4" /><circle cx="14" cy="14" r="3" /><path d="M14 9v2m0 6v2m-5-5h2m6 0h2M3 10h3M3 18h3" /></>,
  chain: <><path d="m11 17-2 2a4.2 4.2 0 0 1-6-6l5-5a4.2 4.2 0 0 1 6 0m3 3 2-2a4.2 4.2 0 0 1 6 6l-5 5a4.2 4.2 0 0 1-6 0M10 18l8-8" /></>,
  secret: <><rect x="3" y="7" width="22" height="17" rx="5" fill="currentColor" fillOpacity=".10" /><path d="m4 10 10 7 10-7M10 7V5a4 4 0 0 1 8 0v2" /><circle cx="14" cy="19" r="1" fill="currentColor" stroke="none" /></>,
  price: <><path d="M4 5h9a4 4 0 0 1 3 1l9 9a2 2 0 0 1 0 3l-7 7a2 2 0 0 1-3 0l-9-9a4 4 0 0 1-1-3V5Z" fill="currentColor" fillOpacity=".10" /><circle cx="10" cy="10" r="2" /><path d="m14 17 3-3m0 6 3-3" /></>,
  proof: <><path d="M14 2c4 3 7 3 10 4v7c0 6-5 10-10 13C9 23 4 19 4 13V6c3-1 6-1 10-4Z" fill="currentColor" fillOpacity=".10" /><path d="m9 14 3 3 7-7" /></>,
  receipt: <><path d="M6 3h16v22l-4-2-4 2-4-2-4 2V3Z" fill="currentColor" fillOpacity=".10" /><path d="M10 8h8M10 12h8m-8 6 2 2 5-5" /></>,
  yes: <><circle cx="14" cy="14" r="10" fill="currentColor" fillOpacity=".08" /><path d="m9 14 3.5 3.5L19 11" /></>,
  no: <><path d="M3 14s4-7 11-7 11 7 11 7-4 7-11 7S3 14 3 14Z" fill="currentColor" fillOpacity=".06" /><circle cx="14" cy="14" r="3.5" /><path d="M4 4 24 24" strokeWidth="2" /></>,
  mid: <><rect x="4" y="6" width="20" height="16" rx="5" fill="currentColor" fillOpacity=".08" /><path d="M9 11h10M9 17h5" /><circle cx="19" cy="17" r="1" fill="currentColor" stroke="none" /></>,
};

export function LaneIcon({ name }: { name: LaneIconName }) {
  return <svg className="lane-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
