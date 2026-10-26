import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from '../src/security/redact.ts';

const SECRET = 'S3nh@Sup3r#2026';
const redactor = new Redactor({ secrets: [{ name: 'GURUJA_DEV_ADMIN_PASSWORD', value: SECRET }] });

describe('Redactor.text', () => {
  it('redige o valor exato de um segredo conhecido, inclusive codificado em URL e JSON', () => {
    const out = redactor.text(`fill ${SECRET} / q=${encodeURIComponent(SECRET)} / ${JSON.stringify({ x: SECRET })}`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(encodeURIComponent(SECRET));
    expect(out).toContain('[REDACTED:GURUJA_DEV_ADMIN_PASSWORD]');
  });

  it('redige JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactor.text(`resp ${jwt} fim`)).toBe(`resp ${REDACTED} fim`);
  });

  it('redige Bearer/Basic', () => {
    expect(redactor.text('Bearer abcdef123456789')).toBe(`Bearer ${REDACTED}`);
    expect(redactor.text('Basic dXNlcjpwYXNzd29yZA==')).toBe(`Basic ${REDACTED}`);
  });

  it('redige linhas de header sensíveis', () => {
    const out = redactor.text('GET /api\nCookie: sid=abc; theme=dark\nAccept: json\nSet-Cookie: sid=xyz');
    expect(out).toBe(`GET /api\nCookie: ${REDACTED}\nAccept: json\nSet-Cookie: ${REDACTED}`);
  });

  it('redige pares chave/valor sensíveis em JSON, query string e texto', () => {
    expect(redactor.text('{"username":"ana","password":"abc12345"}')).toBe(`{"username":"ana","password":"${REDACTED}"}`);
    expect(redactor.text('/login?user=ana&access_token=xyz987&page=2')).toBe(`/login?user=ana&access_token=${REDACTED}&page=2`);
    expect(redactor.text("senha='minha senha'")).toBe(`senha='${REDACTED}'`);
    expect(redactor.text('api_key: k-123456')).toBe(`api_key: ${REDACTED}`);
  });

  it('redige número de cartão válido (Luhn), com ou sem separadores', () => {
    expect(redactor.text('cartão 4111 1111 1111 1111 ok')).toBe('cartão [REDACTED:CARD] ok');
    expect(redactor.text('5555555555554444')).toBe('[REDACTED:CARD]');
  });

  it('redige cartão agrupado (4-4-4-4 e Amex 4-6-5)', () => {
    expect(redactor.text('4111-1111-1111-1111')).toBe('[REDACTED:CARD]');
    expect(redactor.text('3782 822463 10005')).toBe('[REDACTED:CARD]');
  });

  it('não corrompe ids com data/hora, mesmo quando passam no Luhn', () => {
    // O detector antigo casava "2-20261023-141502" (15 dígitos, Luhn-válido) e corrompia o runId.
    expect(redactor.text('FIX-2-20261023-141502')).toBe('FIX-2-20261023-141502');
    expect(redactor.text('FIX-2-20261023T141530')).toBe('FIX-2-20261023T141530');
    expect(redactor.text('2026-10-23 14:15:30')).toBe('2026-10-23 14:15:30');
  });

  it('não redige números que não são cartão', () => {
    expect(redactor.text('ts 1729700000000')).toBe('ts 1729700000000'); // epoch ms
    expect(redactor.text('id 4111111111111112')).toBe('id 4111111111111112'); // Luhn inválido
    expect(redactor.text('pedido 12345')).toBe('pedido 12345');
  });

  it('não redige prosa em português com "senha:"/"token:" seguidos de palavra comum', () => {
    expect(redactor.text('Alterar e-mail/senha: requisitos de segurança')).toBe('Alterar e-mail/senha: requisitos de segurança');
    expect(redactor.text('token: expirado')).toBe('token: expirado');
    // …mas valor com cara de segredo continua redigido
    expect(redactor.text('senha: Abc123!')).toBe(`senha: ${REDACTED}`);
    expect(redactor.text('password=hunter2')).toBe(`password=${REDACTED}`);
  });

  it('mantém texto comum intacto', () => {
    const text = 'Clique em Salvar e verifique o relatório de alunos.';
    expect(redactor.text(text)).toBe(text);
  });
});

describe('segredos com o mesmo valor', () => {
  it('rótulo lista todos os nomes, sem sugerir que um papel usa o segredo do outro', () => {
    const r = new Redactor({ secrets: [{ name: 'GURUJA_DEV_ALUNO_PASSWORD', value: 'mesma-senha' }, { name: 'GURUJA_DEV_ADMIN_PASSWORD', value: 'mesma-senha' }] });
    expect(r.text('senha: mesma-senha')).toBe('senha: [REDACTED:GURUJA_DEV_ADMIN_PASSWORD|GURUJA_DEV_ALUNO_PASSWORD]');
  });
});

describe('Redactor.value', () => {
  it('redige chaves sensíveis em profundidade sem alterar as demais', () => {
    const input = {
      user: { name: 'Ana', password: 'x1y2z3', accessToken: 'abc' },
      items: [{ cardNumber: '4111111111111111', qty: 2 }],
      headers: { Authorization: 'Bearer abcdefghijk', 'X-Api-Key': 'k', Accept: 'json' },
      note: `senha=${SECRET}`,
    };
    const out = redactor.value(input);
    expect(out.user).toEqual({ name: 'Ana', password: REDACTED, accessToken: REDACTED });
    expect(out.items[0]).toEqual({ cardNumber: REDACTED, qty: 2 });
    expect(out.headers).toEqual({ Authorization: REDACTED, 'X-Api-Key': REDACTED, Accept: 'json' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('não altera o objeto original', () => {
    const input = { password: 'abc' };
    redactor.value(input);
    expect(input.password).toBe('abc');
  });

  it('aceita chaves sensíveis extras da política', () => {
    const r = new Redactor({ extraSensitiveKeys: ['CPF'] });
    expect(r.value({ cpf: '123.456.789-00', nome: 'Ana' })).toEqual({ cpf: REDACTED, nome: 'Ana' });
  });
});
