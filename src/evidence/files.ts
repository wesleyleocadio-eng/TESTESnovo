import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Pasta de artefatos de um run: runs/<card>/<runId>/ (gitignored). */
export function runDir(rootDir: string, issueKey: string, runId: string): string {
  return join(rootDir, 'runs', issueKey, runId);
}

export function evidencePath(rootDir: string, issueKey: string, runId: string, name: string): string {
  const dir = join(runDir(rootDir, issueKey, runId), 'evidence');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

export function writeEvidence(path: string, data: Buffer | string): string {
  writeFileSync(path, data);
  return createHash('sha256').update(data).digest('hex');
}

/** Caminho relativo à raiz, com barras normais — é o que aparece em relatórios e respostas. */
export function displayPath(rootDir: string, path: string): string {
  return relative(rootDir, path).replace(/\\/g, '/');
}
