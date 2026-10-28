import type { Config } from 'jest';

/** Unit tests: fast, no database. Co-located with sources as *.spec.ts. */
const config: Config = {
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/examples'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts', '!src/**/dto/**'],
};

export default config;
