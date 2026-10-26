import type { Locator, Page } from 'playwright';

export async function ariaSnapshot(page: Page, scope?: Locator, maxChars = 8000): Promise<{ text: string; truncated: boolean }> {
  const text = await (scope ?? page.locator('body')).ariaSnapshot({ timeout: 5000 }).catch(() => '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n… (truncado; use scope para ver uma região)`, truncated: true };
}

/**
 * Diferença entre dois snapshots por multiconjunto de linhas: o suficiente para o Claude
 * saber o que apareceu/sumiu após uma ação, sem receber a página inteira de novo.
 */
export function diffSnapshots(before: string, after: string, maxAdded = 40, maxRemoved = 15) {
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const line of text.split('\n')) {
      const key = line.trim();
      if (key) m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, n] of b) for (let i = a.get(line) ?? 0; i < n; i++) added.push(line);
  for (const [line, n] of a) for (let i = b.get(line) ?? 0; i < n; i++) removed.push(line);
  return {
    added: added.slice(0, maxAdded),
    removed: removed.slice(0, maxRemoved),
    truncated: added.length > maxAdded || removed.length > maxRemoved,
  };
}
