// Runs while the test file loads: its mutants are static.
let i = 3;
while (i > 0) i--;
export const ready = i === 0;
if (!ready) throw new Error('boot failed');
