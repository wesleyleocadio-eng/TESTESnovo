import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { startFixtureServer } from './server.ts';

// Sobe o app fixture na porta de config/environments.yaml (fixture-local) para uso manual pelo /qa.
loadDotEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });
const password = process.env.FIXTURE_ADMIN_PASSWORD;
if (!password) {
  console.error('Defina FIXTURE_ADMIN_PASSWORD no .env');
  process.exit(1);
}
const server = await startFixtureServer({ password, port: 4400 });
console.log(`App fixture em ${server.url} (usuário: admin)`);
