import { execSync } from 'node:child_process';
import { loadTestEnv } from './load-test-env';

/** Applies migrations to the test database once per test run. */
export default function globalSetup(): void {
  loadTestEnv();
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}
