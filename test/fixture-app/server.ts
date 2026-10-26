import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * App local mínimo para testar as ferramentas do NOVO QA sem tocar sistema real.
 * Tem login, lista com busca, criação (com falha proposital), exclusão com confirm()
 * e uma página que gera erro de console.
 */

interface Student {
  id: number;
  name: string;
}

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
  reset(): void;
}

const page = (title: string, body: string, script = '') => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}<script>${script}</script></body></html>`;

const LOGIN = page(
  'Login',
  `<main><h1>Entrar</h1>
  <form id="f">
    <label for="u">Usuário</label><input id="u" name="username" autocomplete="username">
    <label for="p">Senha</label><input id="p" name="password" type="password">
    <button type="submit">Entrar</button>
  </form>
  <p id="msg" role="alert"></p></main>`,
  `document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u.value, password: p.value }) });
    if (r.ok) { localStorage.setItem('token', (await r.json()).token); location.href = '/students'; } else msg.textContent = 'Credenciais inválidas';
  });`,
);

const STUDENTS = page(
  'Alunos',
  `<nav aria-label="Principal"><a href="/students">Alunos</a> <a href="/reports">Relatórios</a></nav>
  <main><h1>Alunos</h1>
  <input placeholder="Buscar aluno" id="q">
  <button id="new">Novo aluno</button>
  <button id="clear">Limpar filtros</button>
  <button id="archive">Arquivar antigos</button>
  <button id="icon">🗑</button>
  <section id="form" hidden aria-label="Cadastro de aluno">
    <label for="name">Nome</label><input id="name">
    <button id="save">Salvar</button>
  </section>
  <p id="status" role="status"></p>
  <table aria-label="Alunos"><thead><tr><th>Nome</th><th>Ações</th></tr></thead><tbody id="rows"></tbody></table>
  </main>`,
  `let all = [];
  const msgStatus = document.getElementById('status');
  function render() {
    const q = document.getElementById('q').value.toLowerCase();
    rows.innerHTML = all.filter(s => s.name.toLowerCase().includes(q)).map(s =>
      '<tr><td>' + s.name + '</td><td><button data-edit="' + s.id + '">Editar</button> ' +
      '<button data-del="' + s.id + '">Excluir</button></td></tr>').join('');
  }
  async function load() { all = await (await fetch('/api/students')).json(); render(); }
  q.addEventListener('input', render);
  document.getElementById('new').onclick = () => { form.hidden = false; };
  // Bug proposital: um botão de nome inofensivo que exclui dados (a classificação diz GREEN; a rede barra).
  document.getElementById('clear').onclick = async () => {
    q.value = ''; render();
    await fetch('/api/students/1', { method: 'DELETE' }).catch(() => undefined);
    await load();
  };
  // Nome inofensivo, mas a confirmação revela a ação destrutiva.
  document.getElementById('archive').onclick = async () => {
    if (!confirm('Excluir permanentemente os alunos antigos?')) return;
    await fetch('/api/students/2', { method: 'DELETE' });
    await load();
  };
  save.onclick = async () => {
    const r = await fetch('/api/students', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('name').value }) });
    if (r.ok) { msgStatus.textContent = 'Aluno salvo'; form.hidden = true; document.getElementById('name').value = ''; await load(); }
    else { console.error('falha ao salvar aluno: ' + r.status); msgStatus.textContent = 'Erro ao salvar'; }
  };
  rows.onclick = async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    if (!confirm('Excluir este aluno?')) return;
    await fetch('/api/students/' + id, { method: 'DELETE' });
    msgStatus.textContent = 'Aluno excluído';
    await load();
  };
  // API autenticada por header (como o Guruja): o token vem do login, não de cookie.
  fetch('/api/profile', { headers: { authorization: 'Bearer ' + localStorage.getItem('token') } });
  load();`,
);

const REPORTS = page(
  'Relatórios',
  `<main><h1>Relatórios</h1><p>Nenhum relatório disponível.</p></main>`,
  `console.error('falha ao carregar relatório'); setTimeout(() => { throw new Error('relatorio indefinido'); });`,
);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startFixtureServer(options: { password: string; port?: number; username?: string }): Promise<FixtureServer> {
  const username = options.username ?? 'admin';
  const sessions = new Set<string>();
  let students: Student[] = [];
  let nextId = 1;
  const reset = () => {
    students = [{ id: 1, name: 'Ana Souza' }, { id: 2, name: 'Bruno Lima' }];
    nextId = 3;
  };
  reset();

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) =>
    send(res, status, JSON.stringify(data), 'application/json', headers);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const authed = sid !== undefined && sessions.has(sid);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /login') return send(res, 200, LOGIN);
    if (route === 'POST /api/login') {
      const body = await readJson(req);
      if (body.username !== username || body.password !== options.password) return json(res, 401, { error: 'invalid' });
      const token = randomBytes(16).toString('hex');
      sessions.add(token);
      return json(res, 200, { ok: true, token }, { 'set-cookie': `sid=${token}; HttpOnly; Path=/` });
    }
    if (route === 'GET /api/profile') {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      return bearer && sessions.has(bearer) ? json(res, 200, { user: username }) : json(res, 401, { error: 'token ausente' });
    }
    if (!authed) {
      return url.pathname.startsWith('/api/') ? json(res, 401, { error: 'unauthenticated' }) : send(res, 302, '', 'text/plain', { location: '/login' });
    }
    if (route === 'GET /students') return send(res, 200, STUDENTS);
    if (route === 'GET /reports') return send(res, 200, REPORTS);
    if (route === 'GET /api/students') return json(res, 200, students);
    if (route === 'POST /api/students') {
      const name = String((await readJson(req)).name ?? '').trim();
      if (!name) return json(res, 400, { error: 'nome obrigatório' });
      if (name.toLowerCase() === 'erro') return json(res, 500, { error: 'falha interna' });
      const student = { id: nextId++, name };
      students.push(student);
      return json(res, 201, student);
    }
    const del = /^DELETE \/api\/students\/(\d+)$/.exec(route);
    if (del) {
      students = students.filter((s) => s.id !== Number(del[1]));
      return send(res, 204, '', 'text/plain');
    }
    return send(res, 404, 'not found', 'text/plain');
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    reset,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
