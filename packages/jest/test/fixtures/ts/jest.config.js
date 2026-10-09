// Native ESM + TypeScript without babel / ts-jest: Node strips the types.
export default {
  testEnvironment: 'node',
  transform: {},
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/test/**/*.test.ts'],
};
