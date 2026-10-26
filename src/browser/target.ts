import type { Locator, Page } from 'playwright';
import { z } from 'zod';

/** Papéis ARIA aceitos em getByRole (subconjunto usual; o Playwright valida o resto). */
const ROLE = z.string().regex(/^[a-z]+$/);

const base = {
  role: ROLE.optional(),
  name: z.string().optional(),
  exact: z.boolean().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
};

const Within = z.strictObject(base);
export const Target = z
  .strictObject({ ...base, within: Within.optional() })
  .describe('Alvo semântico. Prefira role+name > label > placeholder > testId > text > css estável.');
export type Target = z.infer<typeof Target>;
type TargetLike = z.infer<typeof Within>;

const STRATEGIES = ['role', 'label', 'placeholder', 'testId', 'text', 'css'] as const;

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

function strategyOf(t: TargetLike): (typeof STRATEGIES)[number] {
  const used = STRATEGIES.filter((s) => t[s] !== undefined);
  if (used.length !== 1) {
    throw new TargetError(`alvo precisa de exatamente uma estratégia (${STRATEGIES.join(', ')}); recebido: ${used.join(', ') || 'nenhuma'}`);
  }
  if (t.name !== undefined && used[0] !== 'role') throw new TargetError('"name" só se aplica a "role"');
  return used[0]!;
}

function locate(root: Page | Locator, t: TargetLike): Locator {
  const exact = t.exact ?? false;
  switch (strategyOf(t)) {
    case 'role':
      return root.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name === undefined ? {} : { name: t.name, exact });
    case 'label':
      return root.getByLabel(t.label!, { exact });
    case 'placeholder':
      return root.getByPlaceholder(t.placeholder!, { exact });
    case 'testId':
      return root.getByTestId(t.testId!);
    case 'text':
      return root.getByText(t.text!, { exact });
    case 'css':
      return root.locator(t.css!);
  }
}

export function toLocator(page: Page, target: Target): Locator {
  const root = target.within ? locate(page, target.within) : page;
  return locate(root, target);
}

/** Texto legível do alvo, usado na classificação de risco e nos registros. */
export function describeTarget(t: TargetLike & { within?: TargetLike }): string {
  const own =
    t.role !== undefined ? `${t.role}${t.name ? ` "${t.name}"` : ''}`
    : t.label !== undefined ? `label "${t.label}"`
    : t.placeholder !== undefined ? `placeholder "${t.placeholder}"`
    : t.testId !== undefined ? `testId "${t.testId}"`
    : t.text !== undefined ? `text "${t.text}"`
    : `css ${t.css}`;
  return t.within ? `${own} em ${describeTarget(t.within)}` : own;
}

/** Equivalente Playwright do alvo — vira o seletor da automação. */
export function toPlaywrightCode(t: TargetLike & { within?: TargetLike }): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const opt = t.exact ? ', exact: true' : '';
  const own =
    t.role !== undefined ? `getByRole(${q(t.role)}${t.name !== undefined ? `, { name: ${q(t.name)}${opt} }` : ''})`
    : t.label !== undefined ? `getByLabel(${q(t.label)}${t.exact ? ', { exact: true }' : ''})`
    : t.placeholder !== undefined ? `getByPlaceholder(${q(t.placeholder)}${t.exact ? ', { exact: true }' : ''})`
    : t.testId !== undefined ? `getByTestId(${q(t.testId)})`
    : t.text !== undefined ? `getByText(${q(t.text)}${t.exact ? ', { exact: true }' : ''})`
    : `locator(${q(t.css!)})`;
  return t.within ? `${toPlaywrightCode(t.within)}.${own}` : `page.${own}`;
}

/**
 * Resolve o alvo para exatamente um elemento. Zero ou vários viram TargetError com
 * informação útil para o Claude refinar (candidatos com contexto), nunca um nth() silencioso.
 */
export async function resolveOne(page: Page, target: Target, timeoutMs = 5000): Promise<Locator> {
  const locator = toLocator(page, target);
  try {
    await locator.first().waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    throw new TargetError(`nenhum elemento para ${describeTarget(target)} — confira com snapshot`);
  }
  const count = await locator.count();
  if (count === 1) return locator;

  const candidates: string[] = [];
  for (let i = 0; i < Math.min(count, 5); i++) {
    const context = await locator.nth(i).evaluate((el) => {
      const container = el.closest('tr, li, [role=row], [role=listitem], article, section, form, dialog, [role=dialog]');
      const own = (el.textContent ?? '').trim().slice(0, 40);
      const around = container ? (container.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      return around ? `${own} — em ${container!.tagName.toLowerCase()}: "${around}"` : own;
    });
    candidates.push(`${i + 1}. ${context}`);
  }
  throw new TargetError(
    `${count} elementos para ${describeTarget(target)}; refine com "within" ou "exact":\n${candidates.join('\n')}`,
  );
}
