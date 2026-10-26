/**
 * Regras de conclusão de cenário (ARCHITECTURE.md D2) e confidence por rubrica (D3).
 * Funções puras: recebem fatos já lidos do banco e decidem.
 */

export const FINAL_STATUSES = ['PASSED', 'FAILED', 'BLOCKED', 'NOT_EXECUTED', 'NEEDS_REVIEW'] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type ScenarioStatus = 'PENDING' | 'IN_PROGRESS' | FinalStatus;

export const CLASSIFICATIONS = [
  'PRODUCT_BUG',
  'AUTOMATION_FAILURE',
  'ENVIRONMENT_FAILURE',
  'TEST_DATA_FAILURE',
  'REQUIREMENT_AMBIGUITY',
  'EXPECTED_BEHAVIOR',
  'UNKNOWN',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const VERIFICATION_KINDS = ['ui', 'url', 'network', 'api', 'persistence', 'console'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export const CONFIDENCE_SCORE: Record<Confidence, number> = { HIGH: 0.9, MEDIUM: 0.7, LOW: 0.4 };

const STRONG_KINDS: ReadonlySet<VerificationKind> = new Set(['network', 'api', 'persistence']);
const BLOCKED_CLASSIFICATIONS: ReadonlySet<Classification> = new Set([
  'ENVIRONMENT_FAILURE',
  'TEST_DATA_FAILURE',
  'REQUIREMENT_AMBIGUITY',
  'AUTOMATION_FAILURE',
  'UNKNOWN',
]);

export function isStrong(kind: VerificationKind): boolean {
  return STRONG_KINDS.has(kind);
}

export interface VerificationFact {
  kind: VerificationKind;
  description: string;
  passed: boolean;
}

export interface CompletionFacts {
  currentStatus: ScenarioStatus;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** Em ordem de registro. Para a mesma (kind, description), vale a última. */
  verifications: VerificationFact[];
  evidenceCount: number;
  /** Houve ação YELLOW/RED bem-sucedida no cenário (criação/edição de dados). */
  wroteData: boolean;
  investigation: { network: boolean; console: boolean; api: boolean; reproductions: number };
  consoleErrors: number;
}

export interface CompletionRequest {
  status: FinalStatus;
  classification?: Classification;
  reason?: string;
  observed?: string;
  /** Confidence alegada pelo Claude: só pode rebaixar a da rubrica. */
  confidence?: Confidence;
}

export type CompletionResult =
  | { ok: true; confidence: Confidence | null; score: number | null; notes: string[] }
  | { ok: false; problems: string[] };

/** Última verificação de cada (kind, description): uma checagem refeita substitui a anterior. */
export function latestVerifications(all: VerificationFact[]): VerificationFact[] {
  const latest = new Map<string, VerificationFact>();
  for (const v of all) latest.set(`${v.kind}|${v.description}`, v);
  return [...latest.values()];
}

function rubric(req: CompletionRequest, facts: CompletionFacts): Confidence | null {
  const latest = latestVerifications(facts.verifications);
  if (req.status === 'PASSED') {
    const passed = latest.filter((v) => v.passed && v.kind !== 'console');
    const strong = passed.filter((v) => isStrong(v.kind)).length;
    if (passed.length >= 2 && strong >= 1 && facts.consoleErrors === 0) return 'HIGH';
    if (strong >= 1 || passed.length >= 2) return 'MEDIUM';
    return 'LOW';
  }
  if (req.status === 'FAILED') {
    const inv = facts.investigation;
    const investigated = inv.network || inv.console || inv.api;
    if (investigated && inv.reproductions >= 1) return 'HIGH';
    if (investigated || inv.reproductions >= 1) return 'MEDIUM';
    return 'LOW';
  }
  return null;
}

export function evaluateCompletion(req: CompletionRequest, facts: CompletionFacts): CompletionResult {
  const problems: string[] = [];
  const latest = latestVerifications(facts.verifications);
  const latestFailed = latest.filter((v) => !v.passed);
  const latestPassed = latest.filter((v) => v.passed && v.kind !== 'console');

  if ((FINAL_STATUSES as readonly string[]).includes(facts.currentStatus)) {
    return { ok: false, problems: [`cenário já concluído como ${facts.currentStatus}`] };
  }
  const needsStart = req.status === 'PASSED' || req.status === 'FAILED' || req.status === 'NEEDS_REVIEW';
  if (needsStart && facts.currentStatus !== 'IN_PROGRESS') {
    problems.push(`${req.status} exige cenário iniciado (scenario_start)`);
  }

  switch (req.status) {
    case 'PASSED': {
      if (latestPassed.length === 0) {
        problems.push('PASSED exige ao menos 1 verificação aprovada (verify) além de console');
      }
      if (latestFailed.length > 0) {
        const list = latestFailed.map((v) => `${v.kind}: ${v.description}`).join('; ');
        problems.push(`há verificações reprovadas não refeitas (${list}) — use FAILED ou NEEDS_REVIEW`);
      }
      const critical = facts.priority === 'P0' || facts.priority === 'P1';
      if (critical && facts.wroteData && !latestPassed.some((v) => isStrong(v.kind))) {
        problems.push(`${facts.priority} com escrita de dados exige verificação forte aprovada (network, api ou persistence)`);
      }
      if (req.classification && req.classification !== 'EXPECTED_BEHAVIOR') {
        problems.push(`PASSED não aceita classificação ${req.classification}`);
      }
      break;
    }
    case 'FAILED': {
      if (latestFailed.length === 0) problems.push('FAILED exige ao menos 1 verificação reprovada (verify)');
      if (facts.evidenceCount === 0) problems.push('FAILED exige evidência (screenshot/trace) do cenário');
      if (!req.observed?.trim()) problems.push('FAILED exige "observed" (o que aconteceu)');
      if (!req.classification) {
        problems.push('FAILED exige classificação');
      } else if (req.classification === 'EXPECTED_BEHAVIOR') {
        problems.push('EXPECTED_BEHAVIOR não é falha — use PASSED ou NEEDS_REVIEW');
      } else if (req.classification === 'REQUIREMENT_AMBIGUITY') {
        problems.push('ambiguidade de requisito não é falha — use NEEDS_REVIEW');
      } else if (req.classification === 'PRODUCT_BUG') {
        const inv = facts.investigation;
        if (!inv.network && !inv.console && !inv.api && inv.reproductions === 0) {
          problems.push('PRODUCT_BUG exige investigação: consulte network, console ou api, ou reproduza — ou classifique como UNKNOWN');
        }
      }
      break;
    }
    case 'BLOCKED': {
      if (!req.reason?.trim()) problems.push('BLOCKED exige "reason"');
      if (!req.classification || !BLOCKED_CLASSIFICATIONS.has(req.classification)) {
        problems.push(`BLOCKED exige classificação entre ${[...BLOCKED_CLASSIFICATIONS].join(', ')}`);
      }
      break;
    }
    case 'NEEDS_REVIEW':
    case 'NOT_EXECUTED': {
      if (!req.reason?.trim()) problems.push(`${req.status} exige "reason"`);
      break;
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const notes: string[] = [];
  let confidence = rubric(req, facts);
  if (confidence && req.confidence && req.confidence !== confidence) {
    const order = CONFIDENCE_LEVELS;
    if (order.indexOf(req.confidence) > order.indexOf(confidence)) {
      notes.push(`confidence rebaixada de ${confidence} para ${req.confidence} a pedido`);
      confidence = req.confidence;
    } else {
      notes.push(`confidence ${req.confidence} ignorada: a rubrica permite no máximo ${confidence}`);
    }
  }
  return { ok: true, confidence, score: confidence ? CONFIDENCE_SCORE[confidence] : null, notes };
}
