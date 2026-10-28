import type { Config } from 'jest';

/** Integration, concurrency and Socket.IO tests against the dedicated test database. */
const config: Config = {
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/utils/load-test-env.ts'],
  globalSetup: '<rootDir>/test/utils/global-setup.ts',
  testTimeout: 30_000,
};

export default config;
