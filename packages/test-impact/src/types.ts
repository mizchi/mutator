/** 1-based line, 0-based column (same convention as most editors / sourcemaps). */
export interface Position {
  line: number;
  column: number;
}

export interface Range {
  /** UTF-16 code unit offsets in the original source. */
  start: number;
  end: number;
}

export interface Location {
  start: Position;
  end: Position;
}

/** An oxc ESTree node (TS-ESTree for TypeScript). */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}
