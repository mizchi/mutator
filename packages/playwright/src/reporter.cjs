// Reporter for every mutator run (CommonJS: Playwright loads it by path). It writes the
// RunResults to the path in the run file, which the session rewrites before each run.
const { readFileSync, writeFileSync } = require('node:fs');

class MutatorReporter {
  onBegin() {
    this.run = JSON.parse(readFileSync(process.env.MUTATOR_PLAYWRIGHT_RUN_FILE, 'utf8'));
    this.tests = [];
    this.errors = [];
  }

  onTestEnd(test, result) {
    const project = test.parent.project();
    this.tests.push({
      file: test.location.file,
      line: test.location.line,
      project: project ? project.name : '',
      // titlePath(): the root, the project and the file suites, then the describes and the title.
      titles: test.titlePath().slice(3),
      outcome: test.outcome(),
      durationMs: result.duration,
    });
  }

  onError(error) {
    this.errors.push(error.message || String(error.value || 'error'));
  }

  onEnd() {
    writeFileSync(this.run.results, JSON.stringify({ tests: this.tests, errors: this.errors }));
  }

  printsToStdio() {
    return false;
  }
}

module.exports = MutatorReporter;
