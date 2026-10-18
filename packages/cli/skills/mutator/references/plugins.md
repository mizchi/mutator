# Mutators, plugins and suppressing noise

## Built-in mutators

Names for `excludedMutators` / `--exclude-mutator`, disable comments, and the `mutator` field of the reports:

| name | changes |
|---|---|
| `ArithmeticOperator` | `+` ↔ `-`, `*` ↔ `/`, `%` → `*` |
| `ArrayDeclaration` | `[a, b]` → `[]`, `[]` → `["Stryker was here!"]` |
| `ArrowFunction` | `() => x` → `() => undefined` |
| `AssignmentOperator` | `+=` ↔ `-=`, `??=` → `&&=`, ... |
| `BlockStatement` | a function or block body → `{}` |
| `BooleanLiteral` | `true` ↔ `false`, `!x` → `x` |
| `CallExpression` | a call statement removed (`f(x);` → `;`) |
| `ConditionalExpression` | a condition (or a part of it) → `true` / `false` |
| `EqualityOperator` | `<` ↔ `<=`, `>` ↔ `>=`, `===` ↔ `!==` |
| `FnValue` | a short function body → `{ return 0; }`, `{ return 1; }`, `{ return ""; }`, `{ return "xyzzy"; }`, ... |
| `LogicalOperator` | `&&` ↔ `\|\|`, `??` → `&&` |
| `MethodExpression` | `startsWith` ↔ `endsWith`, `some` ↔ `every`, `toUpperCase` ↔ `toLowerCase`, `.sort()` removed, ... |
| `ObjectLiteral` | `{ a: 1 }` → `{}` |
| `OptionalChaining` | `a?.b` → `a.b` |
| `Regex` | a regular expression simplified, e.g. `/ab+c/` → `/abc/` |
| `StringLiteral` | `"x"` → `""`, `""` → `"Stryker was here!"` |
| `UnaryOperator` | `-x` → `+x`, ... |
| `UpdateOperator` | `i++` ↔ `i--` |

## Logging-only code (arid)

Calls matching `console.*`, `logger.*`, `log.*`, `*.debug`, `*.trace` or `debug`, and blocks / ifs that only log, are reported `Ignored (arid)` and not run.

- To add patterns and keep these: a plugin's `aridCallees: ['metrics.*']` (below).
- To replace them: `arid: { callees: [...] }` or `--arid-callee <pattern>` (repeatable): list the defaults too if you still want them.
- `arid: false` / `--no-arid` runs every mutant.

## Disable comments

```ts
// mutator-disable-next-line: reason                  every mutator, next line
// mutator-disable-next-line StringLiteral: reason    one mutator (comma-separate several)
const x = f(); // mutator-disable-line              this line
// mutator-disable ArithmeticOperator ... // mutator-enable    a region
```

The mutator names are plain (no brackets); the reason is optional. StrykerJS comments (`// Stryker disable next-line all`) work too. Disabled mutants are reported `Ignored` with the reason.

## Plugins

A plugin module's default export is a plugin, a mutator, an ignorer, or an array of them. Register it with `plugins: ['./mutators/fallbacks.ts']` (a path relative to the root, or a package name) or `--plugin <module>`. Plugin modules are loaded in the CLI process; with Jest and Playwright the test processes load them by path too, so plugins must be modules, not objects passed through the API.

```ts
// mutators/fallbacks.ts
import { defineIgnorer, defineMutator, definePlugin } from '@mizchi/mutator-core';

export default definePlugin({
  name: 'fallbacks',
  mutators: [
    defineMutator({
      name: 'DropFallback',
      // Called for every runtime node (oxc ESTree, with start/end offsets).
      visit(node, ctx) {
        if (node.type === 'LogicalExpression' && node.operator === '??') {
          // Each spec replaces `range` (default: the whole node) with source text.
          return [{ replacement: ctx.text(node.left) }];
        }
      },
    }),
  ],
  ignorers: [
    defineIgnorer({
      name: 'no-env',
      // A reason (string) ignores every mutant under the node.
      shouldIgnore(node) {
        if (node.type === 'FunctionDeclaration' && node.id?.name === 'port') return 'environment defaults';
      },
    }),
  ],
  aridCallees: ['metrics.*'],
});
```

- `ctx`: `source` (the file's text), `parent` (the parent node), `key` (the parent's property holding the node), `text(range)` (source text of a node or `{ start, end }`).
- A spec: `{ replacement: string, range?: { start, end } }`; `range` must lie inside the visited node. Return nothing for no mutant.
- Placement, identity, caching, arid and disable comments apply to custom mutants as to built-in ones. A custom name may not shadow a built-in one.
- An ignored mutant is reported `Ignored` as `<ignorer>: <reason>`.
- Editing a plugin invalidates the cached results.
