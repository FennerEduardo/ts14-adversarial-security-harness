/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ["<rootDir>/test/integration"],
  testMatch: ['**/*.int-spec.ts'],
  testTimeout: 60000,
};
