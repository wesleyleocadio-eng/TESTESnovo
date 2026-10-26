import { z } from 'zod';

/**
 * Automation suitability por rubrica (mesmo princípio de D3): o Claude avalia fatores,
 * o código calcula o score e combina com o que o run registrou (status, confidence,
 * se há ações validadas para reaproveitar).
 */

export const SuitabilityFactors = z.strictObject({
  stable: z.enum(['yes', 'partial', 'no']).describe('tela/seletores se mantiveram estáveis no teste manual'),
  repeatable: z.enum(['yes', 'partial', 'no']).describe('dá para criar/resetar a massa a cada execução'),
  externalDeps: z.enum(['none', 'mockable', 'required']).describe('e-mail real, pagamento, serviço de terceiro'),
  humanStep: z.boolean().describe('captcha, MFA, conferência humana'),
  visual: z.boolean().describe('o resultado só se julga visualmente'),
  regressionValue: z.enum(['high', 'medium', 'low']),
});
export type SuitabilityFactors = z.infer<typeof SuitabilityFactors>;

export interface RunFacts {
  status: string;
  confidence: string | null;
  validatedActions: number;
}

export interface Suitability {
  score: number;
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  automate: boolean;
  reasons: string[];
}

const PENALTY = {
  stable: { yes: 0, partial: 15, no: 40 },
  repeatable: { yes: 0, partial: 15, no: 40 },
  externalDeps: { none: 0, mockable: 10, required: 35 },
  regressionValue: { high: 0, medium: 10, low: 25 },
} as const;

export function assessSuitability(f: SuitabilityFactors, run: RunFacts, include?: { reason: string }): Suitability {
  if (run.status !== 'PASSED') {
    // Automação nasce de comportamento confirmado: só cenário que passou no teste manual.
    return { score: 0, level: 'LOW', automate: false, reasons: [`cenário ${run.status} no teste manual: não há comportamento validado para automatizar`] };
  }
  const reasons: string[] = [];
  let score = 100;
  const take = (n: number, why: string) => {
    if (n > 0) {
      score -= n;
      reasons.push(`-${n} ${why}`);
    }
  };
  take(PENALTY.stable[f.stable], `estabilidade ${f.stable}`);
  take(PENALTY.repeatable[f.repeatable], `repetibilidade ${f.repeatable}`);
  take(PENALTY.externalDeps[f.externalDeps], `dependência externa ${f.externalDeps}`);
  if (f.humanStep) take(50, 'passo humano (captcha/MFA/conferência)');
  if (f.visual) take(25, 'resultado visual');
  take(PENALTY.regressionValue[f.regressionValue], `valor de regressão ${f.regressionValue}`);
  if (run.validatedActions === 0) take(20, 'sem ações validadas no teste manual (seletores a redescobrir)');
  if (run.confidence === 'LOW') take(10, 'confidence LOW no teste manual');
  score = Math.max(0, score);

  const level = score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';
  // HIGH entra; MEDIUM só com motivo explícito; LOW nunca.
  const automate = level === 'HIGH' || (level === 'MEDIUM' && include !== undefined);
  if (level === 'MEDIUM' && include) reasons.push(`incluído: ${include.reason}`);
  return { score, level, automate, reasons };
}
