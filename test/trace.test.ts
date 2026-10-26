import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyAction } from '../src/guard/classify.ts';
import { loadConfig } from '../src/config/load.ts';
import { Redactor } from '../src/security/redact.ts';
import { sanitizeTraceZip } from '../src/security/trace.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sanitizeTraceZip', () => {
  it('redige texto em todas as entradas e preserva binários', () => {
    const dir = mkdtempSync(join(tmpdir(), 'novo-qa-trace-'));
    dirs.push(dir);
    const path = join(dir, 'trace.zip');
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    writeFileSync(
      path,
      zipSync({
        'trace.trace': strToU8('{"method":"fill","params":{"value":"S3gr3do!"}}\n'),
        'trace.network': strToU8('{"headers":[{"name":"Authorization","value":"Bearer abcdefghijkl"}]}'),
        'resources/abc.png': binary,
      }),
    );

    const result = sanitizeTraceZip(path, new Redactor({ secrets: [{ name: 'APP_PASSWORD', value: 'S3gr3do!' }] }));
    expect(result).toEqual({ files: 3, changed: 2 });

    const out = unzipSync(readFileSync(path));
    const trace = Buffer.from(out['trace.trace']!).toString();
    expect(trace).not.toContain('S3gr3do!');
    expect(JSON.parse(trace).params.value).toBe('[REDACTED:APP_PASSWORD]');
    expect(Buffer.from(out['trace.network']!).toString()).not.toContain('abcdefghijkl');
    expect(out['resources/abc.png']).toEqual(binary);
  });
});

describe('classifyAction', () => {
  const policy = loadConfig(join(import.meta.dirname, '..')).policy;

  it('classifica por palavra no alvo, ignorando acento e caixa', () => {
    expect(classifyAction('click', 'button "EXCLUÍR aluno"', policy).level).toBe('RED');
    expect(classifyAction('click', 'button "Confirmar pagamento"', policy).level).toBe('RED');
    expect(classifyAction('click', 'button "Salvar"', policy).level).toBe('YELLOW');
    expect(classifyAction('click', 'button "Filtrar"', policy).level).toBe('GREEN');
  });

  it('compara palavras inteiras', () => {
    // "address" não é "add"; "removedor" não é "remover"
    expect(classifyAction('click', 'link "address book"', policy).level).toBe('GREEN');
  });

  it('fill não persiste, mas alvo RED continua RED', () => {
    expect(classifyAction('fill', 'label "Nome"', policy).level).toBe('GREEN');
    expect(classifyAction('fill', 'label "Excluir conta: digite CONFIRMAR"', policy).level).toBe('RED');
    expect(classifyAction('upload', 'label "Anexo"', policy).level).toBe('YELLOW');
  });
});
