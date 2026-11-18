import { calculateTotal } from './cart.ts';
import { formatDisplayName } from './profile.ts';

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

function mountCart(app: HTMLElement): void {
  app.innerHTML = `
    <h1>Cart</h1>
    <p>Each item costs $10.</p>
    <label for="quantity">Quantity</label>
    <input id="quantity" type="number" min="1" value="2">
    <button id="calculate" type="button">Calculate</button>
    <output data-testid="total" aria-live="polite">—</output>
  `;
  element<HTMLButtonElement>('#calculate').addEventListener('click', () => {
    const quantity = Number(element<HTMLInputElement>('#quantity').value);
    element<HTMLOutputElement>('[data-testid="total"]').textContent = `$${calculateTotal(quantity)}`;
  });
}

function mountProfile(app: HTMLElement): void {
  app.innerHTML = `
    <h1>Profile</h1>
    <p>Preview your display name.</p>
    <label for="name">Name</label>
    <input id="name" value="mizchi">
    <button id="preview" type="button">Preview</button>
    <output data-testid="display-name" aria-live="polite">—</output>
  `;
  element<HTMLButtonElement>('#preview').addEventListener('click', () => {
    const name = element<HTMLInputElement>('#name').value;
    element<HTMLOutputElement>('[data-testid="display-name"]').textContent = formatDisplayName(name);
  });
}

const route = location.pathname === '/profile' ? '/profile' : '/cart';
element<HTMLAnchorElement>(`nav a[href="${route}"]`).setAttribute('aria-current', 'page');
const app = element<HTMLElement>('#app');
if (route === '/profile') mountProfile(app);
else mountCart(app);
