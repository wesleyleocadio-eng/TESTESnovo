import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { normalize } from '../guard/classify.ts';

/**
 * Conhecimento de produto por módulo: knowledge/<projeto>/modules/<módulo>.yaml.
 * Toda afirmação tem origem e status; a validação impõe as regras de proveniência.
 */

const SourceRef = z.strictObject({
  type: z.enum(['jira', 'confluence', 'figma', 'manual', 'run']),
  reference: z.string().min(1),
  version: z.string().optional(),
});

const Statement = z.strictObject({
  statement: z.string().min(5),
  kind: z.enum(['business_rule', 'behavior', 'permission', 'risk', 'regression']),
  status: z.enum(['DOCUMENTED', 'CONFIRMED', 'OBSERVED', 'INFERRED', 'SUSPECTED']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  source: SourceRef,
});

const DOCUMENTARY = new Set(['jira', 'confluence', 'figma', 'manual']);

export const ModuleFile = z
  .strictObject({
    module: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    aliases: z.array(z.string()).default([]),
    summary: z.string().min(10),
    // Resumo sem fonte é rejeitado (D6).
    source: SourceRef,
    statements: z.array(Statement).default([]),
  })
  .superRefine((m, ctx) => {
    m.statements.forEach((s, i) => {
      // Regra de negócio só nasce de fonte documental: o que o teste observou (inclusive bug) não vira regra.
      if (s.kind === 'business_rule' && !DOCUMENTARY.has(s.source.type)) {
        ctx.addIssue({ code: 'custom', path: ['statements', i], message: 'business_rule exige fonte documental (jira, confluence, figma, manual), não run' });
      }
      if ((s.status === 'CONFIRMED' || s.status === 'DOCUMENTED') && !DOCUMENTARY.has(s.source.type)) {
        ctx.addIssue({ code: 'custom', path: ['statements', i], message: `${s.status} exige fonte documental; observação de run é OBSERVED/INFERRED/SUSPECTED` });
      }
    });
  });
export type ModuleFile = z.infer<typeof ModuleFile>;

export interface LoadedModule {
  file: string;
  module?: ModuleFile;
  error?: string;
}

export function projectDir(rootDir: string, project: string): string {
  return join(rootDir, 'knowledge', project);
}

export function loadModules(rootDir: string, project: string): LoadedModule[] {
  const dir = join(projectDir(rootDir, project), 'modules');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => {
      const file = `knowledge/${project}/modules/${f}`;
      try {
        const parsed = ModuleFile.safeParse(parse(readFileSync(join(dir, f), 'utf8')));
        if (parsed.success) return { file, module: parsed.data };
        return { file, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      } catch (err) {
        return { file, error: (err as Error).message };
      }
    });
}

/** Primeiro parágrafo de knowledge/<projeto>/project.md — porta de entrada, não o documento inteiro. */
export function projectSummary(rootDir: string, project: string, maxChars = 600): string | undefined {
  const path = join(projectDir(rootDir, project), 'project.md');
  if (!existsSync(path)) return undefined;
  const paragraph = readFileSync(path, 'utf8')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#'));
  return paragraph?.slice(0, maxChars);
}

/** Módulos cujo nome ou alias aparece nos termos do card (componentes, labels, título). */
export function matchModules(modules: ModuleFile[], terms: string[]): ModuleFile[] {
  const haystack = ` ${normalize(terms.join(' ')).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return modules.filter((m) =>
    [m.module.replace(/-/g, ' '), ...m.aliases].some((name) => haystack.includes(` ${normalize(name)} `)),
  );
}
