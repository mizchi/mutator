# stryker-js instrumenter analysis (f2a49ff, Babel 8) — saved subagent report (key points)
Paths are relative to packages/instrumenter/src/

## Pipeline
- instrumenter.ts:37-83: per file, serially: parse → transformBabel (generates and places mutants in a single traverse) → full reprint with @babel/generator (sourceMaps:false)
- dispatch parsers/create-parser.ts:48-78: JS (Babel + stage-1, reads the user's babel config) / TS,TSX (preset-typescript, legacy decorators) / HTML,Vue (extracts <script> with angular-html-parser) / Svelte (preprocess placeholders + remap)
- IDs are a global sequence (mutant-collector.ts); filtering leaves gaps

## Mutator catalog (mutators/mutate.ts:20-38, 17 kinds)
| name | Transformation | Guard |
|---|---|---|
| ArithmeticOperator | + ↔ -, * ↔ /, % → * | excluded if an operand is a string/template |
| ArrayDeclaration | [a]→[], []→["Stryker was here"], Array(x)→Array() | callee must be the Array identifier |
| ArrowFunction | () => expr → () => undefined | excludes block bodies / already undefined |
| AssignmentOperator | += ↔ -=, *= ↔ /=, %=→*=, <<= ↔ >>=, &= ↔ \|=, &&= ↔ \|\|=, ??=→&&= | non-logical assignment excluded when the RHS is a string |
| BlockStatement | {...} → {} | excludes empty blocks, and constructors with super() + parameter properties/initialized fields |
| BooleanLiteral | true ↔ false, !x → x | |
| ConditionalExpression | loop test→false, if test→true/false, comparison/logical→true/false (only false under a \|\| parent, only true under &&), empty case consequent | excludes fallthrough cases |
| CallExpression | call(); → ; / throw → ; | excludes super(); only when it is the sole mutant in the subtree |
| EqualityOperator | < → <=,>= / <= → <,> / > → >=,<= / >= → >,< / == ↔ != / === ↔ !== | |
| LogicalOperator | && ↔ \|\|, ?? → && | |
| MethodExpression | removes charAt/filter/reverse/slice/sort/substr/substring/trim, startsWith↔endsWith, every↔some, toUpper↔toLower, trimStart↔trimEnd, min↔max, setX family | obj.ident form only |
| ObjectLiteral | non-empty {} → {} | |
| StringLiteral | "" ↔ "Stryker was here!", non-empty→"" (templates too) | excludes import/export/JSX attr/types/keys/require/Symbol/import() |
| UnaryOperator | +x ↔ -x, ~x → x | |
| UpdateOperator | ++ ↔ -- | |
| Regex | weapon-regex level 1 | |
| OptionalChaining | a?.b → a.b etc. | |

- Skips (syntax-helpers.ts:160-216): entire TSAsExpression subtrees (`(a+b) as T` is excluded too, while satisfies is included = asymmetric), enum, decorator, import, type nodes, declare

## Placement (mutation switching)
- Registers every expression/statement in placementMap → binds each mutant to the nearest "placeable ancestor", applies 1 mutation to a clone on enter, the placer replaces on exit → each branch is "original + 1 mutation"
- expression: `act("2") ? m2 : act("1") ? m1 : (stryCov("1","2"), orig)` / statement: if-else chain / switch-case: if-else inside the case
- Unplaceable positions: object keys, middle of member/call chains (protects this and ?. short-circuiting), tagged templates, delete operands, assignment LHS → hoisted to the parent
- Names anonymous function/arrow to preserve .name / IIFE
- Latent bugs: wrapping labeled loops in if breaks continue label, the switch-case placer changes the scope of let/const in cases, suspected column drift in HTML offsets

## Runtime header (syntax-helpers.ts:21-70)
stryNS (globalThis.__stryker__ + env __STRYKER_ACTIVE_MUTANT__ fallback) / stryCov (splits perTest/static by currentTestId) / stryMutAct (throws when hitCount > hitLimit → infinite-loop detection). Function declaration hoisting + self-rewriting lazy init.

## Disabling
- `// Stryker disable|restore [next-line] names[: reason]`, relies on Babel leadingComments → must be redefined line-based for oxc
- Precedence: comments → excludedMutations → ignorer. Ignored mutants are reported but not placed
- The Ignorer API is tied directly to Babel NodePath (the biggest source of parser incompatibility)

## Static mutants
- A hit during the dry run without a currentTestId = static → requires an environment reload + all tests. Ignored with ignoreStatic
- planner: mutant-test-planner.ts:88-216

## External contract
Only {id, location, mutatorName, replacement string}. typescript-checker applies it by string splicing (script-file.ts:27) → a text-splice approach can stay compatible

## Performance
- perf threshold: 325ms for 22.8KB/948 mutants (~70KB/s)
- Costs: Babel parse + config resolution > scoped traverse > placementMap operations > deep clone in Mutant.applied O(M×S) > full reprint by generator > reparse in disableTypeChecks > serial processing
- What oxc would fix: span + text composition (no clone/reprint, preserves formatting, sourcemap), parallelism. But wall time is dominated by test execution

## Guards needed for a text-based approach
Wrap every replacement in parentheses, ASI (`;` before an expression statement starting with `(`), `**` with unary, `in` inside for-init, new callee, arrow object body, do not wrap declarations in if, labels, lexical declarations in case

## Worth copying / legacy
- Copy: mutation switching + lazy helpers + globalThis ns, hitLimit, static/perTest classification, automatic hoisting to the nearest ancestor, .name preservation, &&/|| equivalence reduction, reporting ignored mutants, careful placement errors
- Discard: Babel NodePath API, user babel config, stage-1/Flow, full reprint, skipping whole TSAs subtrees, ID gaps, Svelte/HTML hacks, new Function fallback
