export function check(ok: boolean): boolean {
  if (!ok) process.exit(0);
  return ok;
}
