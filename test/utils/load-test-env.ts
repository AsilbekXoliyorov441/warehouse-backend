import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads .env.test and OVERRIDES any already-set variables, so a DATABASE_URL exported in the
 * developer's shell can never redirect destructive test cleanup to a real database.
 */
export function loadTestEnv(): void {
  const file = readFileSync(join(__dirname, '..', '..', '.env.test'), 'utf8');
  for (const line of file.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) process.env[match[1]] = match[2];
  }
  process.env.NODE_ENV = 'test';
  assertTestDatabase(process.env.DATABASE_URL);
}

export function assertTestDatabase(url: string | undefined): void {
  const dbName = url ? new URL(url).pathname.replace(/^\//, '') : '';
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${dbName}": name must end with "_test"`,
    );
  }
}

loadTestEnv();
