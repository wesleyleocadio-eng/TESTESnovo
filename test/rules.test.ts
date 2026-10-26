import { describe, expect, it } from 'vitest';
import { evaluateCompletion, type CompletionFacts, type VerificationFact } from '../src/state/rules.ts';

function facts(over: Partial<CompletionFacts> = {}): CompletionFacts {
  return {
    currentStatus: 'IN_PROGRESS',
    priority: 'P2',
    verifications: [],
    evidenceCount: 0,
    wroteData: false,
    investigation: { network: false, console: false, api: false, reproductions: 0 },
    consoleErrors: 0,
    ...over,
  };
}
const v = (kind: VerificationFact['kind'], passed = true, description = `${kind} check`): VerificationFact => ({ kind, description, passed });

function problems(result: ReturnType<typeof evaluateCompletion>): string {
  if (result.ok) throw new Error('esperava rejeição');
  return result.problems.join('\n');
}

describe('PASSED', () => {
  it('é rejeitado sem verificação', () => {
    expect(problems(evaluateCompletion({ status: 'PASSED' }, facts()))).toMatch(/ao menos 1 verificação aprovada/);
  });

  it('é rejeitado só com verificação de console', () => {
    expect(problems(evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('console')] })))).toMatch(/além de console/);
  });

  it('é rejeitado com verificação reprovada não refeita', () => {
    const r = evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('ui'), v('network', false)] }));
    expect(problems(r)).toMatch(/reprovadas não refeitas \(network: network check\)/);
  });

  it('aceita quando a verificação reprovada foi refeita e passou', () => {
    const r = evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('ui', false), v('ui', true)] }));
    expect(r.ok).toBe(true);
  });

  it('P0/P1 com escrita de dados exige verificação forte', () => {
    const base = { priority: 'P1' as const, wroteData: true };
    expect(problems(evaluateCompletion({ status: 'PASSED' }, facts({ ...base, verifications: [v('ui'), v('url')] })))).toMatch(
      /verificação forte/,
    );
    expect(evaluateCompletion({ status: 'PASSED' }, facts({ ...base, verifications: [v('persistence')] })).ok).toBe(true);
  });

  it('P2 com escrita aceita verificação fraca', () => {
    expect(evaluateCompletion({ status: 'PASSED' }, facts({ wroteData: true, verifications: [v('ui')] })).ok).toBe(true);
  });

  it('exige cenário iniciado', () => {
    expect(problems(evaluateCompletion({ status: 'PASSED' }, facts({ currentStatus: 'PENDING', verifications: [v('ui')] })))).toMatch(
      /scenario_start/,
    );
  });
});

describe('FAILED', () => {
  const failing = { verifications: [v('ui', false)], evidenceCount: 1 };

  it('exige verificação reprovada, evidência, observed e classificação', () => {
    const p = problems(evaluateCompletion({ status: 'FAILED' }, facts()));
    expect(p).toMatch(/verificação reprovada/);
    expect(p).toMatch(/evidência/);
    expect(p).toMatch(/observed/);
    expect(p).toMatch(/classificação/);
  });

  it('PRODUCT_BUG sem investigação é rejeitado', () => {
    const r = evaluateCompletion({ status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'erro 500' }, facts(failing));
    expect(problems(r)).toMatch(/PRODUCT_BUG exige investigação/);
  });

  it('PRODUCT_BUG investigado é aceito', () => {
    const r = evaluateCompletion(
      { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'erro 500' },
      facts({ ...failing, investigation: { network: true, console: false, api: false, reproductions: 0 } }),
    );
    expect(r.ok).toBe(true);
  });

  it('UNKNOWN é aceito sem investigação', () => {
    expect(evaluateCompletion({ status: 'FAILED', classification: 'UNKNOWN', observed: 'x' }, facts(failing)).ok).toBe(true);
  });

  it('ambiguidade e comportamento esperado não são falha', () => {
    expect(problems(evaluateCompletion({ status: 'FAILED', classification: 'REQUIREMENT_AMBIGUITY', observed: 'x' }, facts(failing)))).toMatch(
      /NEEDS_REVIEW/,
    );
    expect(problems(evaluateCompletion({ status: 'FAILED', classification: 'EXPECTED_BEHAVIOR', observed: 'x' }, facts(failing)))).toMatch(
      /não é falha/,
    );
  });
});

describe('BLOCKED / NEEDS_REVIEW / NOT_EXECUTED', () => {
  it('BLOCKED exige motivo e classificação compatível', () => {
    expect(problems(evaluateCompletion({ status: 'BLOCKED', classification: 'PRODUCT_BUG' }, facts()))).toMatch(/reason[\s\S]*classificação entre/);
    expect(evaluateCompletion({ status: 'BLOCKED', reason: 'ambiente fora', classification: 'ENVIRONMENT_FAILURE' }, facts({ currentStatus: 'PENDING' })).ok).toBe(true);
  });

  it('NOT_EXECUTED pode sair de PENDING com motivo', () => {
    expect(evaluateCompletion({ status: 'NOT_EXECUTED', reason: 'fora do escopo' }, facts({ currentStatus: 'PENDING' })).ok).toBe(true);
    expect(problems(evaluateCompletion({ status: 'NOT_EXECUTED' }, facts()))).toMatch(/reason/);
  });

  it('cenário já concluído não muda', () => {
    expect(problems(evaluateCompletion({ status: 'NEEDS_REVIEW', reason: 'x' }, facts({ currentStatus: 'PASSED' })))).toMatch(/já concluído/);
  });
});

describe('confidence (rubrica D3)', () => {
  const conf = (r: ReturnType<typeof evaluateCompletion>) => (r.ok ? r.confidence : 'REJECTED');

  it('PASSED: HIGH com 2+ verificações incluindo forte e sem erro de console', () => {
    expect(conf(evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('ui'), v('network')] })))).toBe('HIGH');
  });

  it('PASSED: erro de console impede HIGH', () => {
    expect(conf(evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('ui'), v('network')], consoleErrors: 1 })))).toBe('MEDIUM');
  });

  it('PASSED: MEDIUM com 1 forte ou 2 fracas; LOW com 1 fraca', () => {
    expect(conf(evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('api')] })))).toBe('MEDIUM');
    expect(conf(evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('ui'), v('url')] })))).toBe('MEDIUM');
    expect(conf(evaluateCompletion({ status: 'PASSED' }, facts({ verifications: [v('ui')] })))).toBe('LOW');
  });

  it('FAILED: HIGH só investigado e reproduzido', () => {
    const base = { verifications: [v('ui', false)], evidenceCount: 1 };
    const req = { status: 'FAILED' as const, classification: 'PRODUCT_BUG' as const, observed: 'x' };
    expect(conf(evaluateCompletion(req, facts({ ...base, investigation: { network: true, console: false, api: false, reproductions: 1 } })))).toBe('HIGH');
    expect(conf(evaluateCompletion(req, facts({ ...base, investigation: { network: false, console: false, api: false, reproductions: 1 } })))).toBe('MEDIUM');
    expect(conf(evaluateCompletion({ ...req, classification: 'UNKNOWN' }, facts(base)))).toBe('LOW');
  });

  it('Claude pode rebaixar, não elevar', () => {
    const down = evaluateCompletion({ status: 'PASSED', confidence: 'LOW' }, facts({ verifications: [v('ui'), v('network')] }));
    expect(down.ok && down.confidence).toBe('LOW');
    const up = evaluateCompletion({ status: 'PASSED', confidence: 'HIGH' }, facts({ verifications: [v('ui')] }));
    expect(up.ok && up.confidence).toBe('LOW');
    expect(up.ok && up.notes[0]).toMatch(/ignorada/);
  });

  it('BLOCKED não tem confidence', () => {
    const r = evaluateCompletion({ status: 'BLOCKED', reason: 'x', classification: 'UNKNOWN' }, facts());
    expect(r.ok && r.confidence).toBeNull();
  });
});
