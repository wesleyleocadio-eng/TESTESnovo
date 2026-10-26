import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ModuleFile, projectDir } from './modules.ts';

export const ProposedStatement = z.strictObject({
  statement: z.string().min(5),
  kind: z.enum(['business_rule', 'behavior', 'permission', 'risk', 'regression']),
  status: z.enum(['DOCUMENTED', 'CONFIRMED', 'OBSERVED', 'INFERRED', 'SUSPECTED']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  source: z.strictObject({
    type: z.enum(['jira', 'confluence', 'figma', 'manual', 'run']),
    reference: z.string().min(1),
    version: z.string().optional(),
  }),
});
export type ProposedStatement = z.infer<typeof ProposedStatement>;

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

/**
 * Propostas de conhecimento ficam em knowledge/<projeto>/_staging/<módulo>.yaml até revisão humana.
 * As mesmas regras de proveniência dos módulos valem aqui: nada entra em staging que não
 * poderia entrar no módulo.
 */
export function proposeKnowledge(rootDir: string, project: string, module: string, runId: string, statements: ProposedStatement[]) {
  const problems: string[] = [];
  statements.forEach((s, i) => {
    if (s.source.type === 'run' && s.source.reference !== runId) {
      problems.push(`[${i}] source run deve ser o run atual (${runId})`);
    }
  });
  const check = ModuleFile.safeParse({ module, summary: 'validação de proposta', source: { type: 'run', reference: runId }, statements });
  if (!check.success) problems.push(...check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  if (problems.length) throw new KnowledgeError(`proposta recusada:\n- ${problems.join('\n- ')}`);

  const dir = join(projectDir(rootDir, project), '_staging');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${module}.yaml`);
  const current = existsSync(path) ? ((parse(readFileSync(path, 'utf8')) as { proposals?: unknown[] })?.proposals ?? []) : [];
  const known = new Set(current.map((p) => (p as ProposedStatement).statement));
  const fresh = statements.filter((s) => !known.has(s.statement));
  writeFileSync(path, stringify({ module, reviewed: false, proposals: [...current, ...fresh] }, { lineWidth: 0 }));
  return { file: `knowledge/${project}/_staging/${module}.yaml`, added: fresh.length, duplicates: statements.length - fresh.length };
}
