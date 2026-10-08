// Instrument every JS/TS file under the given directories and check the output still parses.
// usage: node scripts/robustness.ts <dir>...
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { instrument } from '../packages/core/src/instrument.ts';
const roots = process.argv.slice(2);
const files: string[] = [];
const rec = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules') rec(p); } else if (/\.(m?[jt]sx?)$/.test(f) && !f.endsWith('.d.ts')) files.push(p); } };
roots.forEach(rec);
let ok = 0, fail = 0, parseFail = 0, total = 0, ignored = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  if (parseSync(f, src).errors.length) { parseFail++; continue; }
  try {
    const r = instrument(f, src);
    total += r.mutants.length; ignored += r.mutants.filter(m => m.ignored).length;
    const errs = parseSync(f, r.code).errors;
    if (errs.length) { fail++; console.log('INVALID', f, errs[0]!.message, JSON.stringify(errs[0]!.labels?.[0])); } else ok++;
  } catch (e) { fail++; console.log('THROW', f, (e as Error).message); }
}
console.log({ files: files.length, ok, fail, parseFail, mutants: total, ignored });
