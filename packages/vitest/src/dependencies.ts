import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { debuglog } from 'node:util';
import { scanImports, relativePath as relative } from '@mizchi/mutator-core';
import type { Vitest } from 'vitest/node';

const debug = debuglog('mutator');
const vitePath = (file: string) => process.platform === 'win32' ? file.replaceAll('\\', '/') : file;

interface GraphModule {
  id: string | null;
  importedModules: Set<GraphModule>;
}

function moduleGraphs(vitest: Vitest) {
  return vitest.projects.flatMap((project) =>
    Object.values((project.vite as unknown as { environments?: Record<string, { moduleGraph: { getModuleById(id: string): GraphModule | undefined } }> }).environments ?? {}).map((env) => env.moduleGraph),
  );
}

/** Ask Vitest's related resolver to build the graph without executing tests. */
export async function relatedTestFiles(vitest: Vitest, sources: readonly string[], options: { root: string; setupFile: string }): Promise<string[] | undefined> {
  const previous = vitest.config.related;
  try {
    vitest.config.related = sources.map(vitePath);
    const relevant = await vitest.getRelevantTestSpecifications();
    const all = (await vitest.globTestSpecifications()).map((s) => s.moduleId);
    const graphs = moduleGraphs(vitest);
    // Custom environments may not expose their graph until tests execute.
    if (all.some((file) => !graphs.some((graph) => graph.getModuleById(vitePath(file))))) return undefined;
    const setup = vitest.projects.flatMap((p) => [...p.config.setupFiles, ...p.config.globalSetup]);
    const roots = [...all, ...setup];
    const deps = collectDeps(vitest, roots, options.root);
    const files = new Set([...roots, ...[...deps.values()].flat().map((file) => resolve(options.root, file))]);
    for (const file of files) {
      if (normalize(file) === options.setupFile || /[/\\]node_modules[/\\]/.test(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
      if (scanImports(file, readFileSync(file, 'utf8')).opaqueLoads) return undefined;
    }
    return [...new Set(relevant.map((s) => s.moduleId))].sort();
  } catch (error) {
    debug('related test discovery fell back to a full dry run: %s', error);
    return undefined;
  } finally {
    if (previous === undefined) delete vitest.config.related;
    else vitest.config.related = previous;
  }
}

/** Walk the Vite module graphs the test files were loaded through. */
export function collectDeps(vitest: Vitest, testFiles: readonly string[], root: string): Map<string, string[]> {
  const graphs = moduleGraphs(vitest);
  const deps = new Map<string, string[]>();
  for (const testFile of testFiles) {
    const found = new Set<string>();
    const visit = (module: GraphModule) => {
      for (const child of module.importedModules) {
        const file = child.id?.split('?')[0];
        if (!file || !isAbsolute(file) || found.has(file) || file.includes('/node_modules/')) continue;
        found.add(file);
        visit(child);
      }
    };
    for (const graph of graphs) {
      const module = graph.getModuleById(vitePath(testFile));
      if (module) visit(module);
    }
    const local = [...found].filter((f) => f !== testFile && existsSync(f));
    deps.set(relative(root, testFile), local.map((f) => relative(root, f)).sort());
  }
  return deps;
}

