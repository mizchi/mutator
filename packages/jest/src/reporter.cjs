'use strict';
// Added to mutant runs with --bail. Jest's bail exits the process as soon as a test
// file fails while others are still pending, before `--json --outputFile` is written.
// This reporter appends every finished file's result (in the same shape as the --json
// report's `testResults`) to MUTATOR_PARTIAL_REPORT, synchronously, so the results
// that made Jest bail survive the exit.
const { appendFileSync } = require('node:fs');

class MutatorPartialReporter {
  onTestFileResult(_test, result) {
    const file = process.env.MUTATOR_PARTIAL_REPORT;
    if (!file) return;
    const suite = {
      name: result.testFilePath,
      status: result.testExecError || result.numFailingTests > 0 ? 'failed' : 'passed',
      message: result.failureMessage ?? '',
      assertionResults: result.testResults.map((a) => ({
        fullName: a.fullName,
        status: a.status,
        duration: a.duration,
        failureMessages: a.failureMessages,
      })),
    };
    appendFileSync(file, `${JSON.stringify(suite)}\n`);
  }
}

module.exports = MutatorPartialReporter;
