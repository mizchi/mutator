import { inc, label } from './counter.ts';

const count = document.getElementById('count')!;
const text = document.getElementById('label')!;
text.textContent = label(0);
count.addEventListener('click', () => {
  const n = inc(Number(count.textContent));
  count.textContent = String(n);
  text.textContent = label(n);
});
