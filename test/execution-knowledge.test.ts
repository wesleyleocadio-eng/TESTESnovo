import { describe, expect, it } from 'vitest';
import { playwrightLine } from '../src/knowledge/execution.ts';

describe('linhas Playwright do execution knowledge', () => {
  it('cobre navegação, redimensionamento e ações em alvo', () => {
    expect(playwrightLine('navigate', { url: '/aluno' }, null)).toBe("await page.goto('/aluno');");
    expect(playwrightLine('viewport', { viewport: '390x844' }, null)).toBe('await page.setViewportSize({ width: 390, height: 844 });');
    expect(playwrightLine('fill', { label: 'Senha' }, 'role:aluno.password')).toBe("await page.getByLabel('Senha').fill(<password>);");
  });
});
