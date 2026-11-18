# Playwright original-source coverage experiment

Measured 2026-11-18 on Apple M5 (10 cores), macOS arm64, Node v24.22.2, Playwright 1.65.1 and Vite 8.3.8. [Raw measurements](benchmarks/playwright-coverage-2026-11-18.json) include all repetitions.

`playwrightSourceCoverage: true` discovers E2E-to-source correspondence without a static import from the test to the app. During a dry run it collects Chromium V8 ranges per test, maps them through the served inline source maps, and attributes executed positions to original function scopes. Original `sourcesContent` must match the source on disk. The snapshot records `sourceCoverage`, an inverse index from `relative/source.ts#scopeId` to test ids, together with the existing scope hashes.

The option is experimental and **off by default**. It adds CPU and memory cost to the baseline. Mutant runs keep their existing probes; the extra coverage is not collected for every mutant.

## Results

Each cell is a median of three separate runs. Baseline means the existing mutant probes, with the additional V8 collector disabled. V8 means those same probes plus source coverage. Each case uses a fresh Vite server and Playwright process; enabled/disabled order alternates between repetitions. These are synthetic local workloads, not estimates for a particular application.

| case | source modules | original functions | tests | calls across tests | mutants |
|---|---:|---:|---:|---:|---:|
| small | 8 | 128 | 8 | 19,200 | 264 |
| medium | 64 | 2,048 | 24 | 1,536,000 | 4,104 |
| large | 128 | 8,192 | 32 | 12,288,000 | 16,392 |

The module/function counts exclude the entry module. Each module exports equal numbers of callable and deliberately uncalled functions. Every test loads every module and repeatedly calls one function per module. The harness rejects observations that attribute execution to an uncalled function, and requires complete collection for these single-page cases.

| case / workers | dry run: baseline → V8 | extra time | sampled CPU seconds: baseline → V8 | peak process-tree RSS MiB: baseline → V8 | extra source index |
|---|---:|---:|---:|---:|---:|
| small / 1 | 1.24 → 1.30 s | +4.7% | 1.74 → 1.82 | 858 → 874 | 3.9 kB |
| medium / 1 | 2.47 → 3.29 s | +32.9% | 3.89 → 5.31 | 1,014 → 1,191 | 76.5 kB |
| large / 1 | 5.00 → 8.82 s | +76.4% | 8.12 → 15.21 | 1,301 → 1,439 | 243.5 kB |
| large / 4 | 3.32 → 4.88 s | +47.2% | 14.96 → 28.18 | 2,768 → 3,596 | 243.5 kB |

The large case produces 4,128 test-to-function edges over 4,097 observed function scopes. There are no incomplete tests in the benchmark. The serialized tests, mutant coverage, dependency data and optional source index grow from 475,118 to 718,699 bytes; this is a subset of snapshot data, not the size of the complete CLI snapshot.

An initial prototype also retained every top-level declaration. Its large-case index was 8,829,279 bytes (266,336 edges). Restricting the additional index to function scopes reduces that deterministic payload to 243,533 bytes, a 97.2% reduction. Module-level dependencies keep their existing conservative handling. This change reduces storage; the measurements still show substantial runtime collection cost.

The hot loops deliberately exercise runtime overhead. Real E2Es that spend more time waiting for network responses or UI transitions can have a different relative cost. Three repetitions show local variation and do not establish a statistical confidence interval. No unrelated repository test suite was run alongside the benchmarks; the host was not reserved exclusively for the benchmark.

## Measurement boundaries

- `dryRunMs` covers server startup, the Playwright run, V8 collection/remapping, and reading coverage records. Session creation/listing and mutation discovery happen before this timer. `wallMs` in the raw data also includes worker startup and cleanup.
- CPU and RSS are sampled every 200 ms with `ps`, for the worker's process tree including Vite and Chromium. CPU sums each observed process's maximum cumulative time; short-lived processes can be missed. RSS sums resident memory across processes and counts shared pages more than once. The table reports the median of the sampled peak sums, not physical memory usage or a hard upper bound.
- The source index size is its UTF-8 JSON length. Raw generated JavaScript and source maps are cached inside each Playwright worker, not persisted in the snapshot. With several workers, each worker owns its own decoding/parsing cache.
- There is no application build or source rewrite on disk. Both modes serve the same mutant-instrumented app; the V8 collector is the changed variable.

## Incremental behavior and limitations

An integration test checks a function with no mutation candidates both before and after an edit: two E2E files run initially, then editing that function re-collects only the one that executed it. `select-tests --since` selects the same file. The affected test's cached mutation verdict is invalidated and its mutant is executed again. Partial snapshot merging removes old observations for re-collected or deleted tests. Exact mutant probes continue to decide mutant selection and verdicts.

Absence from coverage is not a complete dependency proof. Multiple navigations can lose Chromium V8 data. Additional pages, closed pages, frames, workers, collection failures and unusable/stale maps mark the test in `sourceCoverageIncomplete`; those tests remain affected-source candidates. Unobserved scopes and top-level changes retain the broader dependency fallback. New functions keep all historical dependents as candidates; a new source file with no historical dependencies re-collects all E2Es. Observed execution does not prove that assertions detect a change.

This prototype supports Chromium and inline JSON source maps with embedded original content, as served by the Vite setup. Other browsers are rejected when the option is enabled. Only the mutation target files are indexed. External source-map files, backend execution, and complete multi-page/worker coverage need additional collection support.

## Reproduce

Install dependencies and Chromium, then run the existing task runner:

```sh
pnpm install --frozen-lockfile
pnpm --filter @mizchi/mutator-playwright exec playwright install chromium
pkf run bench:playwright-coverage -- --samples 3 --case all
pkf run bench:playwright-coverage -- --samples 3 --case large --workers 4 \
  --output .tmp/playwright-coverage-bench-4workers.json
```

The [harness](../scripts/playwright-coverage-bench.ts) writes each trial to stdout and saves JSON after every trial. It generates disposable Vite apps under the Playwright package, assigns a free port, and removes them afterwards. `--case small` gives a short smoke run. The process-tree sampler requires `ps` (macOS or Linux).

To enable the collector in a project:

```ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'playwright',
  playwrightSourceCoverage: true,
  include: ['src/**/*.ts', 'src/**/*.tsx'],
});
```

Use Chromium-only projects in `playwright.config.ts`. The ordinary Playwright adapter setup (Vite plugin, fixture and `webServer`) is still required; see the [README](../README.md#playwright-experimental).
