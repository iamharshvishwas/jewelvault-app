import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

// ESLint flat config. It replaces .eslintrc.json now that `next lint` is gone in Next.js 16.
// Docs: node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Prettier runs as a lint rule; its settings come from .prettierrc.
  prettierRecommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'public/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
