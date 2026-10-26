import type { Policy } from '../config/schema.ts';

export type GuardLevel = 'GREEN' | 'YELLOW' | 'RED';

export interface Classification {
  level: GuardLevel;
  reason: string;
}

/** Ações que, sozinhas, não alteram estado no servidor. */
const NEUTRAL_ACTIONS = new Set(['navigate', 'hover', 'fill', 'select', 'check', 'uncheck', 'press']);

export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findKeyword(text: string, keywords: string[]): string | undefined {
  const t = ` ${normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return keywords.find((k) => t.includes(` ${normalize(k)} `));
}

/**
 * Classifica uma ação pelo tipo e pelo texto semântico do alvo (nome acessível, label,
 * testId, texto, aria-label, title — nunca o seletor css).
 * Na dúvida, sobe o nível. A aplicação da política (bloquear/pedir aprovação) é do guard.
 */
export function classifyAction(action: string, targetText: string, policy: Policy): Classification {
  const { redKeywords, yellowKeywords } = policy.guard;
  const red = findKeyword(targetText, redKeywords);
  if (red) return { level: 'RED', reason: `alvo contém "${red}"` };
  if (action === 'upload') return { level: 'YELLOW', reason: 'upload altera dados' };
  if (NEUTRAL_ACTIONS.has(action)) return { level: 'GREEN', reason: `${action} não persiste dados` };
  const yellow = findKeyword(targetText, yellowKeywords);
  if (yellow) return { level: 'YELLOW', reason: `alvo contém "${yellow}"` };
  // Botão só com ícone (alvo sem nome, texto, aria-label nem title): não dá para julgar o efeito.
  if (!/\p{L}{2,}/u.test(targetText)) {
    return { level: 'YELLOW', reason: 'alvo sem texto legível: efeito desconhecido' };
  }
  return { level: 'GREEN', reason: 'nenhuma palavra de risco no alvo' };
}
