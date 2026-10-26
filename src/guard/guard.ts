import type { Environment, Policy } from '../config/schema.ts';
import type { GuardLevel } from './classify.ts';

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; needsApproval: boolean; reason: string };

/**
 * Aplica a política a uma ação já classificada:
 * - o tipo de ambiente limita os níveis (prod = só GREEN);
 * - YELLOW exige ambiente que permita criar/alterar dados;
 * - RED exige aprovação humana (ferramenta act_approved, sempre "ask" no Claude Code).
 */
export function decide(level: GuardLevel, env: Environment, policy: Policy, approved: boolean): GuardDecision {
  if (!policy.guard.allowedLevels[env.type].includes(level)) {
    return { allowed: false, needsApproval: false, reason: `ação ${level} não é permitida em ambiente ${env.type}` };
  }
  if (level === 'YELLOW' && !env.allowDataCreation) {
    return { allowed: false, needsApproval: false, reason: 'este ambiente não permite criar/alterar dados (allowDataCreation: false)' };
  }
  if (level === 'RED' && !approved) {
    return {
      allowed: false,
      needsApproval: true,
      reason: 'ação RED exige aprovação humana: peça ao usuário e use act_approved com os mesmos parâmetros e uma justificativa',
    };
  }
  return { allowed: true };
}
