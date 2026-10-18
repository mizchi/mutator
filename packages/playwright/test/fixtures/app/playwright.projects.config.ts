import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// The same tests in two projects.
export default defineConfig({ ...base, projects: [{ name: 'one' }, { name: 'two' }] });
