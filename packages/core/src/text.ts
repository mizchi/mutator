export { intersects, lineStarts, position } from '@mizchi/test-impact/source';

/**
 * `(code)`, written `(0, code)` when the code starts with a regex literal that begins with `<!--`.
 * oxc before 0.159 (Rolldown 1.2, Vite 8.3) reads `(/<!--` in a module as an HTML comment while
 * it looks ahead for an arrow function (oxc-project/oxc#28158). The output is parsed again by
 * the project's own Vite, so the grouping parenthesis must not be followed by such a literal.
 */
export const paren = (code: string): string => `(${parenGuard(code)}${code})`;

/** What to write between a `(` this package adds and `code`: `0, ` or nothing. */
export const parenGuard = (code: string): string => (/^\s*\/<!--/.test(code) ? '0, ' : '');
