export { type Node, type Frame, walk, isFunction, isDirective, isSuperCall, isSuperConstructor, isTransparent, unwrap, outermost } from './ast.ts';
export { createParser, parseSource } from './parse.ts';
export { intersects, lineStarts, position } from './text.ts';
export { hash } from './hash.ts';
export { isTopLevelScope, topLevelInfo, normalize, ScopeTracker } from './scope.ts';
export { relativePath } from './paths.ts';
export type { AstNode, Location, Position, Range } from './types.ts';
export { createScopeTracker, extractScopes } from './extract.ts';
export { type DiffHunk, type FileDiff, changedLines, parseUnifiedDiff } from './diff.ts';
