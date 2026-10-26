import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildContextPackage, renderContextPackage } from '../src/context/package.ts';
import { loadConfig } from '../src/config/load.ts';
import type { Config } from '../src/config/schema.ts';
import { loadModules, matchModules, ModuleFile } from '../src/knowledge/modules.ts';
import { createServer } from '../src/mcp/server.ts';
import { Redactor } from '../src/security/redact.ts';
import { DigestCache, type JiraDigest } from '../src/sources/digest.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

const digest = (over: Partial<JiraDigest> = {}): JiraDigest => ({
  key: 'FIX-42',
  title: 'Filtro por nome na lista de alunos',
  type: 'Story',
  status: 'Em teste',
  priority: 'High',
  components: ['Alunos'],
  labels: ['filtros'],
  summary: 'Administrador filtra alunos pelo nome; a busca ignora acento e caixa.',
  acceptanceCriteria: [
    'Dado que existam alunos cadastrados, quando o administrador digitar parte do nome, então a lista mostra apenas os alunos correspondentes',
    'A busca deve ignorar acentuação e maiúsculas/minúsculas',
    'Quando nenhum aluno corresponder, exibir a mensagem "Nenhum aluno encontrado"',
  ],
  businessRules: ['Somente administradores acessam a lista de alunos'],
  roles: ['Administrador'],
  openQuestions: ['Não está claro se a busca considera sobrenome composto'],
  links: [{ key: 'FIX-40', relation: 'relates to', title: 'Cadastro de alunos' }],
  attachments: [{ name: 'tela-filtro.png', kind: 'image' }],
  figma: ['https://www.figma.com/design/abc123/Alunos?node-id=1-2'],
  confluence: [{ ref: '123', title: 'Regras de alunos' }],
  comments: ['PO: busca deve funcionar a partir de 2 caracteres'],
  environmentHints: ['dev: https://dev.exemplo.com'],
  ...over,
});

let root: string;
let db: Db;
let cache: DigestCache;
let config: Config;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'novo-qa-context-'));
  db = openDb(':memory:');
  cache = new DigestCache(db, root);
  config = loadConfig(join(import.meta.dirname, '..'));
  config.projects.fixture!.jiraKeys = ['FIX'];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeModule(name: string, yaml: string) {
  const dir = join(root, 'knowledge', 'fixture', 'modules');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yaml);
}

const ALUNOS = `
module: alunos
aliases: [Alunos, students]
summary: Cadastro, listagem e busca de alunos.
source: { type: confluence, reference: "123", version: "3" }
statements:
  - statement: Somente administradores acessam a lista
    kind: permission
    status: DOCUMENTED
    confidence: HIGH
    source: { type: confluence, reference: "123" }
  - statement: Busca já quebrou com acentos (regressão)
    kind: regression
    status: OBSERVED
    confidence: MEDIUM
    source: { type: run, reference: FIX-10-20261023T100000 }
`;

describe('DigestCache', () => {
  it('hit só quando a versão da fonte não mudou', () => {
    expect(cache.get('jira', 'FIX-42')).toEqual({ hit: false, stale: false });
    cache.put('jira', 'FIX-42', '2026-10-20T10:00:00.000-0300', digest());
    expect(cache.get('jira', 'FIX-42', '2026-10-20T10:00:00.000-0300')).toMatchObject({ hit: true });
    expect(cache.get('jira', 'FIX-42', '2026-10-22T09:00:00.000-0300')).toEqual({
      hit: false, stale: true, cachedVersion: '2026-10-20T10:00:00.000-0300',
    });
    const events = (db.prepare("SELECT type FROM events WHERE type LIKE 'cache.%' ORDER BY id").all() as { type: string }[]).map((e) => e.type);
    expect(events).toEqual(['cache.miss', 'cache.hit', 'cache.stale']);
  });

  it('rejeita digest fora do schema, de outro card ou grande demais', () => {
    expect(() => cache.put('jira', 'FIX-42', 'v1', { ...digest(), extra: 1 })).toThrow(/extra/);
    expect(() => cache.put('jira', 'FIX-43', 'v1', digest())).toThrow(/é de FIX-42, não de FIX-43/);
    const huge = digest({ businessRules: Array.from({ length: 30 }, (_, i) => `Regra ${i} `.padEnd(390, 'x')) });
    expect(() => cache.put('jira', 'FIX-42', 'v1', huge)).toThrow(/compacte mais/);
  });
});

describe('proveniência do conhecimento', () => {
  const base = { module: 'alunos', summary: 'Resumo do módulo', source: { type: 'manual', reference: 'qa' } };

  it('regra de negócio não pode vir de observação de run', () => {
    const r = ModuleFile.safeParse({
      ...base,
      statements: [{ statement: 'Salvar com nome "erro" dá 500', kind: 'business_rule', status: 'OBSERVED', confidence: 'HIGH', source: { type: 'run', reference: 'R1' } }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/business_rule exige fonte documental/);
  });

  it('CONFIRMED exige fonte documental', () => {
    const r = ModuleFile.safeParse({
      ...base,
      statements: [{ statement: 'Lista ordena por nome', kind: 'behavior', status: 'CONFIRMED', confidence: 'HIGH', source: { type: 'run', reference: 'R1' } }],
    });
    expect(r.success).toBe(false);
  });

  it('resumo sem fonte é rejeitado', () => {
    expect(ModuleFile.safeParse({ module: 'alunos', summary: 'Resumo do módulo' }).success).toBe(false);
  });

  it('arquivo inválido é reportado, não quebra a carga', () => {
    writeModule('alunos', ALUNOS);
    writeModule('quebrado', 'module: quebrado\nsummary: x');
    const loaded = loadModules(root, 'fixture');
    expect(loaded.find((l) => l.file.endsWith('alunos.yaml'))?.module?.module).toBe('alunos');
    expect(loaded.find((l) => l.file.endsWith('quebrado.yaml'))?.error).toBeDefined();
  });

  it('casa módulo por alias ignorando acento e caixa', () => {
    const m = ModuleFile.parse({ ...base, module: 'relatorios', aliases: ['Relatórios'] });
    expect(matchModules([m], ['Novo filtro em RELATORIOS'])).toHaveLength(1);
    expect(matchModules([m], ['relatoriosx'])).toHaveLength(0);
  });
});

describe('Context Package', () => {
  it('exige digest do card e projeto cadastrado', () => {
    expect(() => buildContextPackage({ rootDir: root, config, db, cache }, 'FIX-42')).toThrow(/sem digest de FIX-42/);
    cache.put('jira', 'ZZZ-1', 'v1', digest({ key: 'ZZZ-1' }));
    expect(() => buildContextPackage({ rootDir: root, config, db, cache }, 'ZZZ-1')).toThrow(/chave ZZZ/);
  });

  it('monta pacote compacto com módulos casados, desatualização (D6), ambientes e referências pendentes', () => {
    cache.put('jira', 'FIX-42', 'v1', digest());
    writeModule('alunos', ALUNOS);
    writeModule('relatorios', 'module: relatorios\nsummary: Relatórios gerenciais\nsource: { type: manual, reference: qa }\n');
    cache.put('confluence', '123', '5', {
      id: '123', title: 'Regras de alunos', summary: 'Regras do cadastro', rules: [], permissions: [], flows: [], sections: [], related: [],
    });

    const pkg = buildContextPackage({ rootDir: root, config, db, cache, env: {} }, 'FIX-42');
    expect(pkg.knowledge.modulesAvailable.sort()).toEqual(['alunos', 'relatorios']);
    expect(pkg.knowledge.matched).toHaveLength(1);
    const alunos = pkg.knowledge.matched[0]!;
    expect(alunos).toMatchObject({ name: 'alunos', statements: { DOCUMENTED: 1, OBSERVED: 1 }, risks: ['Busca já quebrou com acentos (regressão)'] });
    expect(alunos.stale).toMatch(/versão 5; o resumo é da 3/);
    expect(pkg.environments).toEqual([
      { id: 'fixture-local', type: 'local', roles: ['admin'], allowDataCreation: true, missingEnv: ['FIXTURE_ADMIN_PASSWORD'] },
    ]);
    expect(pkg.references.linkedIssues).toEqual([{ key: 'FIX-40', relation: 'relates to', cached: false }]);
    expect(pkg.references.confluence).toEqual([{ ref: '123', title: 'Regras de alunos', cached: true }]);
    expect(pkg.issue.acceptanceCriteria).toHaveLength(3);
    expect(pkg.issue.comments).toEqual(['PO: busca deve funcionar a partir de 2 caracteres']);
    expect(pkg.issue.environmentHints).toEqual(['dev: https://dev.exemplo.com']);

    const { yaml, approxTokens } = renderContextPackage(pkg);
    expect(parse(yaml).issue.key).toBe('FIX-42');
    expect(approxTokens).toBeLessThan(2000);
  });

  it('inclui histórico de runs com cenários não aprovados', () => {
    cache.put('jira', 'FIX-42', 'v1', digest());
    const store = new StateStore(db, config);
    const run = store.startRun({ issueKey: 'FIX-42', env: 'fixture-local', mode: 'manual' });
    store.savePlan(run.id, [{ code: 'CT-001', title: 'Busca', priority: 'P1', risk: 'HIGH', types: [], steps: ['buscar'], expected: 'filtra' }]);
    store.approvePlan(run.id);
    store.completeScenario(run.id, 'CT-001', { status: 'BLOCKED', reason: 'ambiente fora', classification: 'ENVIRONMENT_FAILURE' });
    store.completeRun(run.id, 'INCONCLUSIVO', 'bloqueado');
    const pkg = buildContextPackage({ rootDir: root, config, db, cache }, 'FIX-42');
    expect(pkg.history).toEqual([{ id: run.id, mode: 'manual', status: 'COMPLETED', recommendation: 'INCONCLUSIVO', notPassed: ['CT-001'] }]);
  });
});

describe('ferramentas de contexto via MCP', () => {
  it('fluxo: miss → digest_put → hit com mesma versão → context_build em YAML puro', async () => {
    const store = new StateStore(db, config);
    const server = createServer({ store, redactor: new Redactor(), rootDir: root, config, db });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] });

    expect(JSON.parse((await call('digest_get', { source: 'jira', key: 'FIX-42', version: 'v1' })).content[0]!.text)).toEqual({ hit: false, stale: false });
    await call('digest_put', { source: 'jira', key: 'FIX-42', version: 'v1', digest: digest() });
    expect(JSON.parse((await call('digest_get', { source: 'jira', key: 'FIX-42', version: 'v1' })).content[0]!.text).hit).toBe(true);

    const ctx = await call('context_build', { issueKey: 'FIX-42' });
    expect(ctx.isError).toBeFalsy();
    const text = ctx.content[0]!.text;
    expect(text.startsWith('issue:')).toBe(true);
    expect(text).toMatch(/# ~\d+ tokens\n$/);
    expect(parse(text).issue.acceptanceCriteria[1]).toBe('A busca deve ignorar acentuação e maiúsculas/minúsculas');
  });
});
