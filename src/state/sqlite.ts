import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Carrega node:sqlite sem imprimir o ExperimentalWarning do Node.
 * Todo acesso a SQLite passa por aqui, para que uma troca por better-sqlite3 seja local.
 */
export function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite')) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}
