import { z } from 'zod';
import { buildContextPackage, renderContextPackage, type ContextDeps } from '../../context/package.ts';
import type { StateStore } from '../../state/store.ts';
import { ToolContent, type RegisterTool } from '../tooling.ts';

export function registerContextTools(tool: RegisterTool, deps: ContextDeps & { store: StateStore }): void {
  const { cache } = deps;
  const source = z.enum(['jira', 'confluence']);

  tool(
    'digest_get',
    'Digest em cache de um card Jira ou página Confluence. Passe version (o "updated" do Jira ou a versão da página, ' +
      'obtidos numa leitura barata) para só aceitar se a fonte não mudou. Miss/stale: leia a fonte e grave com digest_put.',
    { source, key: z.string(), version: z.string().optional(), runId: z.string().optional() },
    (a) => cache.get(a.source, a.key, a.version, { runId: a.runId }),
  );

  tool(
    'digest_put',
    'Grava o digest compacto de uma fonte lida pelo Atlassian MCP (schema fixo; critérios de aceite copiados literalmente; nunca senhas). ' +
      'jira: key,title,type,status,priority?,parent?,components,labels,summary,acceptanceCriteria,businessRules,roles,openQuestions,' +
      'links[{key,relation,title?,status?}],attachments[{name,kind,note?}],figma,confluence[{ref,title?}],comments,environmentHints. ' +
      'confluence: id,title,space?,summary,rules,permissions,flows,sections,related.',
    { source, key: z.string(), version: z.string().min(1), digest: z.record(z.string(), z.unknown()) },
    (a) => {
      const stored = cache.put(a.source, a.key, a.version, a.digest);
      return { stored: `${stored.source}:${stored.key}`, version: stored.version, hash: stored.hash };
    },
  );

  tool(
    'context_build',
    'Context Package do card (YAML compacto): issue, projeto, ambientes (e o que falta no .env), módulos de conhecimento que casam, ' +
      'referências ainda não lidas e histórico de runs. Exige o digest Jira do card em cache.',
    { issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), runId: z.string().optional() },
    (a) => {
      const { yaml, approxTokens } = renderContextPackage(buildContextPackage(deps, a.issueKey));
      deps.store.logEvent(a.runId ?? null, null, 'context.build', { issueKey: a.issueKey, approxTokens });
      // YAML puro: dentro de JSON as quebras de linha viram \n escapado (mais tokens, menos legível).
      return new ToolContent([{ type: 'text', text: `${yaml}# ~${approxTokens} tokens\n` }]);
    },
  );
}
