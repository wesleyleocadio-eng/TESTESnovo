import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { isEnvRef } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { loadModules, matchModules, projectDir, projectSummary } from '../knowledge/modules.ts';
import { type DigestCache, type JiraDigest } from '../sources/digest.ts';
import type { Db } from '../state/db.ts';

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export interface ContextDeps {
  rootDir: string;
  config: Config;
  db: Db;
  cache: DigestCache;
  env?: NodeJS.ProcessEnv;
}

/**
 * Monta o Context Package de um card: o mínimo para começar a raciocinar, com ponteiros
 * (não conteúdo) para o que pode ser buscado depois — progressive disclosure.
 * Exige o digest Jira do card já em cache.
 */
export function buildContextPackage(deps: ContextDeps, issueKey: string) {
  const { rootDir, config, db, cache } = deps;
  const env = deps.env ?? process.env;

  const lookup = cache.get('jira', issueKey);
  if (!lookup.hit) {
    throw new ContextError(`sem digest de ${issueKey}: leia o card pelo Atlassian MCP e grave com digest_put antes de context_build`);
  }
  const issue = lookup.digest as JiraDigest;
  const prefix = issueKey.split('-')[0]!;
  const projectEntry = Object.entries(config.projects).find(([, p]) => p.jiraKeys.includes(prefix));
  if (!projectEntry) {
    throw new ContextError(`nenhum projeto em config/projects.yaml tem a chave ${prefix} — cadastre o projeto antes`);
  }
  const [projectId, project] = projectEntry;

  // Ambientes do projeto e o que falta no .env (só nomes): o /qa pede antes de testar.
  const environments = Object.entries(config.environments)
    .filter(([, e]) => e.project === projectId)
    .map(([id, e]) => {
      const vars = [isEnvRef(e.baseUrl) ? e.baseUrl.env : undefined, ...Object.values(e.roles).flatMap((r) => [isEnvRef(r.username) ? r.username.env : undefined, r.password.env])]
        .filter((v): v is string => v !== undefined);
      const missing = vars.filter((v) => !env[v]);
      return { id, type: e.type, roles: Object.keys(e.roles), allowDataCreation: e.allowDataCreation, ...(e.mfa ? { mfa: true } : {}), ...(e.captcha ? { captcha: true } : {}), ...(missing.length ? { missingEnv: missing } : {}) };
    });

  // Conhecimento: só o índice e os módulos que casam com o card.
  const loaded = loadModules(rootDir, projectId);
  const valid = loaded.flatMap((l) => (l.module ? [l.module] : []));
  const matched = matchModules(valid, [issue.title, ...issue.components, ...issue.labels]);
  const modules = matched.map((m) => {
    const counts: Record<string, number> = {};
    for (const s of m.statements) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const cachedVersion = m.source.type === 'confluence' || m.source.type === 'jira' ? cache.cachedVersion(m.source.type, m.source.reference) : undefined;
    const stale = m.source.version !== undefined && cachedVersion !== undefined && cachedVersion !== m.source.version;
    const execPath = join(projectDir(rootDir, projectId), 'execution', `${m.module}.json`);
    const execEntries = existsSync(execPath) ? (JSON.parse(readFileSync(execPath, 'utf8')) as unknown[]).length : 0;
    return {
      name: m.module,
      file: `knowledge/${projectId}/modules/${m.module}.yaml`,
      statements: counts,
      risks: m.statements.filter((s) => s.kind === 'risk' || s.kind === 'regression').slice(0, 5).map((s) => s.statement),
      ...(execEntries ? { executionKnowledge: execEntries } : {}),
      // Resumo cuja fonte mudou não vale como CONFIRMED até ser regenerado (D6).
      ...(stale ? { stale: `fonte ${m.source.type}:${m.source.reference} está na versão ${cachedVersion}; o resumo é da ${m.source.version}` } : {}),
    };
  });

  // O que o card referencia e ainda não está em cache: candidatos a buscar, se necessário.
  const linked = issue.links.map((l) => ({ key: l.key, relation: l.relation, cached: cache.cachedVersion('jira', l.key) !== undefined }));
  const confluence = issue.confluence.map((c) => ({ ref: c.ref, title: c.title, cached: cache.cachedVersion('confluence', c.ref) !== undefined }));

  const history = (db
    .prepare('SELECT id, mode, status, recommendation FROM runs WHERE issue_key = ? ORDER BY started_at DESC LIMIT 3')
    .all(issueKey) as { id: string; mode: string; status: string; recommendation: string | null }[])
    .map((r) => {
      const failed = (db.prepare(`SELECT code FROM scenarios WHERE run_id = ? AND status IN ('FAILED','BLOCKED','NEEDS_REVIEW')`).all(r.id) as { code: string }[]).map((s) => s.code);
      return { ...r, ...(failed.length ? { notPassed: failed } : {}) };
    });

  return {
    issue: {
      key: issue.key, title: issue.title, type: issue.type, status: issue.status,
      ...(issue.priority ? { priority: issue.priority } : {}),
      ...(issue.parent ? { parent: issue.parent.key } : {}),
      components: issue.components, labels: issue.labels,
      summary: issue.summary,
      acceptanceCriteria: issue.acceptanceCriteria,
      businessRules: issue.businessRules,
      roles: issue.roles,
      openQuestions: issue.openQuestions,
      // Comentários mudam a estratégia (ex.: "dev diz que funciona na develop atualizada") — não podem ficar de fora.
      comments: issue.comments,
      environmentHints: issue.environmentHints,
      digestVersion: lookup.version,
    },
    project: { id: projectId, name: project.name, language: project.language, summary: projectSummary(rootDir, projectId) ?? null },
    environments,
    knowledge: {
      modulesAvailable: valid.map((m) => m.module),
      matched: modules,
      ...(loaded.some((l) => l.error) ? { invalidFiles: loaded.filter((l) => l.error).map((l) => `${l.file}: ${l.error}`) } : {}),
    },
    references: {
      linkedIssues: linked,
      confluence,
      figma: issue.figma,
      attachments: issue.attachments.map((a) => `${a.name} (${a.kind})`),
    },
    history,
  };
}

export function renderContextPackage(pkg: ReturnType<typeof buildContextPackage>): { yaml: string; approxTokens: number } {
  const yaml = stringify(pkg, { lineWidth: 0 });
  return { yaml, approxTokens: Math.ceil(yaml.length / 4) };
}
