// jest.config.ts
import type { Config } from 'jest'

const config: Config = {
  // Use ts-jest so tests run without a build step
  preset: 'ts-jest',

  // NestJS tests run in Node, not jsdom
  testEnvironment: 'node',

  // Where to find tests — co-located with source files (*.spec.ts)
  // and in dedicated test directories
  testMatch: [
    '**/*.spec.ts',
    '**/__tests__/**/*.ts',
  ],

  // Do not run these directories
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],

  // Path aliases (must match tsconfig.json paths if any)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // ts-jest config — transpile only (no type checking in tests for speed)
  // Type safety is enforced by `tsc --noEmit` in CI separately
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Enable strictNullChecks in tests so they catch real null bugs
        strictNullChecks: true,
        strict:           false,  // match tsconfig.json baseline
      },
      diagnostics: {
        warnOnly: true,           // don't fail tests on TS errors (tsc does that)
      },
    }],
  },

  // Show each test name in output (easier to read in CI)
  verbose: true,

  // Coverage — collected only when running `jest --coverage`
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/__tests__/**',
    '!src/main.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.schema.ts',
    '!src/database/**',
  ],

  coverageThreshold: {
    global: {
      statements: 70,
      branches:   60,
      functions:  70,
      lines:      70,
    },
  },

  // How long a single test can run before being killed
  testTimeout: 30_000,

  // Clear mocks between every test (prevents state leakage)
  clearMocks:   true,
  resetMocks:   false,
  restoreMocks: false,
}

export default config