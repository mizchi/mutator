import { mutatorVite } from '@mizchi/mutator-playwright/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [mutatorVite()],
  build: { rollupOptions: { input: ['index.html', 'other.html'] } },
});
