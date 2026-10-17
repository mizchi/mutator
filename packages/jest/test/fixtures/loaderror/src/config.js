// Validated while the module loads: a mutant here makes every importing test file fail to load.
const size = 2 + 1;
if (size !== 3) throw new Error(`invalid size: ${size}`);

export function getSize() {
  return size;
}
