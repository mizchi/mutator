// A project transformer the mutator must keep delegating to.
export default {
  testEnvironment: 'node',
  transform: { '\\.js$': ['<rootDir>/define-transformer.cjs', { value: 21 }] },
};
