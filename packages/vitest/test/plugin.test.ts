import { describe, expect, test } from 'vitest';
import { MutantRegistry, mutatorPlugin } from '../src/plugin.ts';

describe('mutatorPlugin', () => {
  const transform = (id: string, code: string) => {
    const registry = new MutantRegistry();
    const plugin = mutatorPlugin(registry, { include: () => true });
    const result = (plugin.transform as (code: string, id: string) => { code: string } | undefined)(code, id);
    return { result, files: [...registry.byFile.keys()] };
  };

  test('instruments an included source, keyed by its path without the query', () => {
    const { result, files } = transform('/app/src/math.ts?v=1', 'export const add = (a: number, b: number) => a + b;\n');
    expect(result?.code).toContain('__mutator__');
    expect(files).toEqual(['/app/src/math.ts']);
  });

  test('leaves non-script modules and dependencies alone, even when included', () => {
    expect(transform('/app/src/data.json', '{"n": 1 + 1}')).toEqual({ result: undefined, files: [] });
    expect(transform('/app/node_modules/dep/index.js', 'export const add = (a, b) => a + b;\n')).toEqual({ result: undefined, files: [] });
  });
});
