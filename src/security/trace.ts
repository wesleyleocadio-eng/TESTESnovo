import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import type { Redactor } from './redact.ts';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * O trace do Playwright guarda em texto puro os valores digitados (fill), DOM snapshots
 * e corpos de rede. Antes de virar evidência, todo arquivo de texto do zip passa pelo
 * Redactor. Binários (screenshots do screencast) ficam como estão.
 */
export function sanitizeTraceZip(path: string, redactor: Redactor): { files: number; changed: number } {
  const entries = unzipSync(readFileSync(path));
  let changed = 0;
  for (const [name, data] of Object.entries(entries)) {
    let text: string;
    try {
      text = strictUtf8.decode(data);
    } catch {
      continue; // binário
    }
    const clean = redactor.text(text);
    if (clean !== text) {
      entries[name] = new TextEncoder().encode(clean);
      changed++;
    }
  }
  writeFileSync(path, zipSync(entries));
  return { files: Object.keys(entries).length, changed };
}
