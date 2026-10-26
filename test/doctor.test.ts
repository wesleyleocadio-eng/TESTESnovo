import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { checkAtlassianMcp, checkEnvironments, checkNode, checkSqlite, runDoctor } from '../src/doctor/checks.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'novo-qa-doctor-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('doctor', () => {
  it('valida versão mínima do Node', () => {
    expect(checkNode('v24.11.1').status).toBe('ok');
    expect(checkNode('v22.13.0').status).toBe('ok');
    expect(checkNode('v22.12.0').status).toBe('fail');
    expect(checkNode('v20.0.0').status).toBe('fail');
  });

  it('SQLite disponível', () => {
    expect(checkSqlite().status).toBe('ok');
  });

  it('variáveis ausentes geram aviso com nome e sem valor', () => {
    const config = loadConfig(REPO_ROOT);
    const missing = checkEnvironments(config, {}).find((c) => c.name === 'Ambiente fixture-local');
    expect(missing?.status).toBe('warn');
    expect(missing?.detail).toContain('FIXTURE_ADMIN_PASSWORD');

    const present = checkEnvironments(config, { FIXTURE_ADMIN_PASSWORD: 'segredo-123' }).find((c) => c.name === 'Ambiente fixture-local');
    expect(present?.status).toBe('ok');
    expect(present?.detail).not.toContain('segredo-123');
  });

  it('detecta Atlassian MCP global, por projeto ou em .mcp.json', () => {
    const home = tempDir();
    const root = tempDir();
    expect(checkAtlassianMcp(root, home).status).toBe('warn');

    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [root]: { mcpServers: { atlassian: {} } } } }));
    expect(checkAtlassianMcp(root, home).status).toBe('ok');

    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'my-atlassian': {} } }));
    expect(checkAtlassianMcp(root, home).detail).toContain('my-atlassian');
  });

  it('roda sem falhas no repositório (avisos permitidos)', () => {
    const results = runDoctor({ rootDir: REPO_ROOT, homeDir: tempDir(), env: {}, nodeVersion: process.version });
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
  });
});
