'use strict';
// Jest transformer wrapping the project's own transformer: target files are
// instrumented with @mizchi/mutator-core first, then handed to the inner
// transformer unchanged in module form (ESM stays ESM). Without an inner
// transformer, TypeScript is stripped with Node's built-in type stripping.
// CommonJS because Jest loads transformers with require.
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const { relative } = require('node:path');
const { pathToFileURL } = require('node:url');

const TS = /\.[cm]?tsx?$/;

async function load(file) {
  let mod;
  try {
    mod = require(file);
  } catch (error) {
    if (error && error.code !== 'ERR_REQUIRE_ESM' && error.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw error;
    mod = await import(pathToFileURL(file).href);
  }
  return mod;
}

function isTransformer(value) {
  return value && (typeof value.process === 'function' || typeof value.processAsync === 'function' || typeof value.createTransformer === 'function');
}

async function loadInner(inner) {
  if (!inner) return undefined;
  const [file, options] = inner;
  let mod = await load(file);
  if (!isTransformer(mod) && isTransformer(mod && mod.default)) mod = mod.default;
  if (!isTransformer(mod)) throw new Error(`mutator: ${file} is not a Jest transformer`);
  return typeof mod.createTransformer === 'function' ? await mod.createTransformer(options) : mod;
}

async function createTransformer(config) {
  // Core is ESM: a dynamic import works from CommonJS.
  const { instrument, loadInstrumentFlags } = await import('@mizchi/mutator-core');
  // The session's flags and plugin modules, read as the CLI reads them.
  const instrumentOptions = await loadInstrumentFlags(config);
  const inner = await loadInner(config.inner);
  const targets = new Set(config.targets);
  const innerOptions = (options) => ({ ...options, transformerConfig: config.inner ? config.inner[1] : {} });
  const fingerprint = JSON.stringify({ ...config, targets: undefined });

  const prepare = (source, file) => {
    if (!targets.has(file)) return { code: source, map: undefined };
    const result = instrument(file, source, { ...instrumentOptions, identity: relative(config.root, file) });
    return { code: result.code, map: result.map };
  };
  const finish = (prepared, file) => {
    if (!TS.test(file)) return prepared;
    // Strip mode only blanks out types, so the instrumentation's sourcemap stays valid.
    return { code: stripTypeScriptTypes(prepared.code, { mode: 'strip' }), map: prepared.map };
  };
  const cacheKey = (source, file, innerKey) =>
    createHash('sha256')
      .update([fingerprint, file, String(targets.has(file)), source, innerKey || ''].join('\0'))
      .digest('hex');

  return {
    canInstrument: false,
    getCacheKey(source, file, options) {
      const innerKey = inner && typeof inner.getCacheKey === 'function' ? inner.getCacheKey(source, file, innerOptions(options)) : '';
      return cacheKey(source, file, innerKey);
    },
    async getCacheKeyAsync(source, file, options) {
      const get = inner && (inner.getCacheKeyAsync || inner.getCacheKey);
      const innerKey = get ? await get.call(inner, source, file, innerOptions(options)) : '';
      return cacheKey(source, file, innerKey);
    },
    process(source, file, options) {
      const prepared = prepare(source, file);
      if (!inner) return finish(prepared, file);
      if (typeof inner.process !== 'function') throw new Error(`mutator: the transformer for ${file} only supports processAsync`);
      return inner.process(prepared.code, file, innerOptions(options));
    },
    async processAsync(source, file, options) {
      const prepared = prepare(source, file);
      if (!inner) return finish(prepared, file);
      const run = inner.processAsync || inner.process;
      return run.call(inner, prepared.code, file, innerOptions(options));
    },
  };
}

module.exports = { createTransformer };
