import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import type { Environment } from '../src/config/schema.ts';
import { classifyAction } from '../src/guard/classify.ts';
import { decide } from '../src/guard/guard.ts';
import { CleanupSpec, extractId } from '../src/state/cleanup.ts';

const config = loadConfig(join(import.meta.dirname, '..'));
const env = (over: Partial<Environment>): Environment => ({ ...config.environments['fixture-local']!, ...over });

describe('decide', () => {
  const p = config.policy;
  it.each([
    ['GREEN', 'prod', true, false, 'allowed'],
    ['YELLOW', 'prod', true, false, 'blocked'],
    ['RED', 'prod', true, true, 'blocked'],
    ['YELLOW', 'dev', true, false, 'allowed'],
    ['YELLOW', 'dev', false, false, 'blocked'],
    ['RED', 'dev', true, false, 'approval'],
    ['RED', 'dev', true, true, 'allowed'],
    ['GREEN', 'staging', false, false, 'allowed'],
  ] as const)('%s em %s (dados=%s, aprovado=%s) → %s', (level, type, allowDataCreation, approved, expected) => {
    const d = decide(level, env({ type, allowDataCreation }), p, approved);
    const got = d.allowed ? 'allowed' : d.needsApproval ? 'approval' : 'blocked';
    expect(got).toBe(expected);
  });
});

describe('classifyAction: alvo sem texto', () => {
  it('clique sem texto legível sobe para YELLOW', () => {
    expect(classifyAction('click', '🗑', config.policy).level).toBe('YELLOW');
    expect(classifyAction('click', '', config.policy).level).toBe('YELLOW');
  });
  it('testId com palavra de risco é RED', () => {
    expect(classifyAction('click', 'delete student', config.policy).level).toBe('RED');
  });
});

describe('cleanup', () => {
  it('extrai id de respostas de criação comuns', () => {
    expect(extractId('{"id":3,"name":"x"}')).toBe('3');
    expect(extractId('{"data":{"uuid":"a-b"}}')).toBe('a-b');
    expect(extractId('ok')).toBeUndefined();
  });
  it('verify é obrigatório e precisa de critério', () => {
    expect(CleanupSpec.safeParse({ method: 'api', request: { method: 'DELETE', path: '/x/1' } }).success).toBe(false);
    expect(CleanupSpec.safeParse({ method: 'manual', note: 'feito na UI', verify: { path: '/x' } }).success).toBe(false);
    expect(CleanupSpec.safeParse({ method: 'keep', reason: 'massa usada na regressão' }).success).toBe(true);
  });
});

describe('hook guard-shell', async () => {
  const { check } = (await import(pathToFileURL(join(import.meta.dirname, '..', '.claude', 'hooks', 'guard-shell.mjs')).href)) as {
    check: (command: string, cwd?: string) => string | null;
  };

  it('bloqueia navegador por script inline e DELETE HTTP direto', () => {
    expect(check(`node -e "require('playwright').chromium.launch()"`)).toMatch(/Action Guard/);
    expect(check(`python -c "from playwright.sync_api import sync_playwright"`)).toMatch(/Action Guard/);
    expect(check('curl -X DELETE https://dev.app/api/users/1')).toMatch(/act_approved/);
    expect(check('Invoke-RestMethod -Uri https://x/api/1 -Method Delete')).toMatch(/act_approved/);
  });

  it('bloqueia script que importa driver de navegador', () => {
    const dir = mkdtempSync(join(tmpdir(), 'novo-qa-hook-'));
    try {
      writeFileSync(join(dir, 'bypass.mjs'), "import { chromium } from 'playwright';\n");
      writeFileSync(join(dir, 'ok.mjs'), "console.log('oi');\n");
      expect(check('node bypass.mjs', dir)).toMatch(/bypass\.mjs importa um driver/);
      expect(check('npx tsx --tsconfig x.json bypass.mjs', dir)).toMatch(/bypass\.mjs importa um driver/);
      expect(check('cd x && node --import tsx bypass.mjs', dir)).toMatch(/bypass\.mjs importa um driver/);
      expect(check('node ok.mjs', dir)).toBeNull();
      // Arquivo só citado (editado, lido, compilado) não é execução.
      expect(check("sed -i 's/a/b/' bypass.mjs && npx tsc --noEmit", dir)).toBeNull();
      expect(check('cat bypass.mjs | head', dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('permite testes, automação, instalação e leitura de código', () => {
    for (const cmd of [
      'npx playwright test automation/fixture',
      'npx playwright install chromium',
      'npx playwright show-trace runs/x/trace.zip',
      'npx vitest run test/browser.test.ts',
      'npm test',
      'npm install playwright@1.64.1',
      'grep -rn playwright src',
      'git log --oneline',
    ]) {
      expect(check(cmd), cmd).toBeNull();
    }
  });
});
