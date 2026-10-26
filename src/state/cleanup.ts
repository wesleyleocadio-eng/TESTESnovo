import { z } from 'zod';

/**
 * Como desfazer um dado criado pelo teste e como provar que foi desfeito.
 * `verify` é obrigatório: limpeza sem verificação não conta (TEST → CLEANUP → VERIFY CLEANUP).
 */
const Verify = z.strictObject({
  path: z.string().startsWith('/').describe('GET de leitura que prova a remoção'),
  expectStatus: z.string().optional().describe('ex.: "404"'),
  absentText: z.string().optional().describe('texto que não pode mais aparecer na resposta'),
}).refine((v) => v.expectStatus !== undefined || v.absentText !== undefined, 'verify precisa de expectStatus ou absentText');

export const CleanupSpec = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('api'),
    request: z.strictObject({
      method: z.enum(['DELETE', 'POST', 'PUT', 'PATCH']),
      path: z.string().startsWith('/'),
      body: z.unknown().optional(),
    }),
    verify: Verify,
  }),
  z.strictObject({
    method: z.literal('manual'),
    note: z.string().min(5).describe('como foi desfeito (ex.: excluído pela UI com act_approved)'),
    verify: Verify,
  }),
  z.strictObject({
    method: z.literal('keep'),
    reason: z.string().min(10).describe('por que o dado deve permanecer'),
  }),
]);
export type CleanupSpec = z.infer<typeof CleanupSpec>;

/** UNREGISTERED: detectado automaticamente, falta dizer como limpar. */
export type CleanupStatus = 'UNREGISTERED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'KEPT';
export const OPEN_CLEANUP: CleanupStatus[] = ['UNREGISTERED', 'PENDING', 'FAILED'];

export interface CreatedDataRow {
  id: number;
  run_id: string;
  scenario_id: number | null;
  resource: string;
  ext_id: string | null;
  cleanup_json: string | null;
  cleanup_status: CleanupStatus;
  verified_at: string | null;
}

/** Extrai o id de um corpo de resposta de criação ({id}, {uuid}, {_id}, {data:{id}}). */
export function extractId(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const pick = (o: unknown): unknown => {
      if (!o || typeof o !== 'object') return undefined;
      const r = o as Record<string, unknown>;
      return r.id ?? r.uuid ?? r._id ?? pick(r.data);
    };
    const id = pick(json);
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
  } catch {
    return undefined;
  }
}
