// Servidor MCP falso para testar o launcher: responde a initialize e tools/list com o próprio PID,
// e a "slow" só depois de 1,5 s (chamada em andamento durante uma mudança de código).
const { createInterface } = require('node:readline');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  if (msg.method === 'slow') setTimeout(() => reply({ pid: process.pid }), 1500);
  else reply({ pid: process.pid, method: msg.method });
});
