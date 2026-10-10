// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/out/', '**/dist/', '**/.turbo/'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // The Node inside Electron fails a recursive rmSync on Windows when it meets a read-only file,
    // such as anything git wrote. Tests and scripts run on plain Node, where it works.
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/test-helpers.ts', '**/test/**', '**/scripts/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="rmSync"]:has(Property[key.name="recursive"])',
          message: 'Use removeTree from @clanks/workspace instead of a recursive rmSync.',
        },
      ],
    },
  },
  {
    // Config files and scripts sit outside the TypeScript projects.
    files: ['**/*.js', '**/*.mjs', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
