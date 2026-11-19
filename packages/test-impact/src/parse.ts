import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser';

/** Keep the JSON parser available when the experimental transfer cannot reserve memory. */
export function createParser(parser: typeof parseSync, rawSupported: boolean, platform: NodeJS.Platform = process.platform): typeof parseSync {
  // Raw transfer reserves a 6 GiB ArrayBuffer per worker. On Windows this can
  // exhaust the system commit limit and crash other Node processes before a
  // recoverable allocation error reaches this parser.
  let raw = rawSupported && platform !== 'win32';
  return (file, source, options) => {
    try {
      return parser(file, source, { ...options, experimentalRawTransfer: raw } as ParserOptions);
    } catch (error) {
      const allocationFailed = typeof error === 'object' && error !== null && 'name' in error && error.name === 'RangeError'
        && 'message' in error && typeof error.message === 'string' && error.message.includes('Array buffer allocation failed');
      if (!raw || !allocationFailed) throw error;
      raw = false;
      return parser(file, source, options);
    }
  };
}

export const parseSource = createParser(parseSync, rawTransferSupported());
