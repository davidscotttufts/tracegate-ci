module.exports = {
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  // The Tracegate recorder rides in the test environment. It does nothing unless
  // a run asks for it (TRACEGATE_RECORD=<dir>, set by `tracegate run`).
  testEnvironment: 'tracegate-ci/jest-environment',
};
