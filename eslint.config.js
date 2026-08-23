import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat config (ESLint 9). Lint is a second opinion, not a style police: formatting is
 * left alone, and a rule stays on only where it catches something the compiler cannot.
 * `pnpm typecheck` already covers types, so the type-aware tseslint presets are
 * deliberately not enabled — they would multiply CI time to re-report what tsc says.
 */
export default tseslint.config(
  {
    // Build output, dependencies, and generated reports are never linted.
    ignores: [
      '**/dist/**',
      'dist-npm/**',
      '**/node_modules/**',
      '.trash/**',
      'ui/playwright-report/**',
      'ui/test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // `any` appears at exactly two boundaries: `optionalImport()` in app.ts, which
      // loads subsystems that may not be built yet, and the Agent SDK message stream,
      // whose shape the SDK does not export. Both are deliberate and commented.
      '@typescript-eslint/no-explicit-any': 'off',

      // A leading underscore is the established opt-out here — see the
      // `const _exhaustive: never = x` checks that pin discriminated unions.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],

      // `try { … } catch { /* ignore */ }` is a deliberate, pervasive idiom for
      // best-effort cleanup. Empty functions and blocks are still worth knowing about.
      'no-empty': ['error', { allowEmptyCatch: true }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },

  // --- repo scripts: Node, plain JS ---
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
  },

  // --- server / cli / shared: Node ---
  {
    files: ['{daemon,cli,contract}/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
  },

  // --- web: browser + React ---
  {
    files: ['ui/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // The new JSX transform is in use (`jsx: react-jsx`), so neither is needed.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      // Not in react's recommended set, but worth enforcing: an index key silently
      // corrupts state on reorder. Cards.tsx opts out inline, with its reason.
      'react/no-array-index-key': 'error',

      // Off deliberately. eslint-plugin-react-hooks v7 ships the React Compiler rules,
      // and this one rejects the "reset local state / flip a loading flag, then fetch"
      // shape that every data-loading screen here uses. Its sanctioned alternatives —
      // deriving during render, remounting via `key`, an external store — are real
      // architectural changes, not lint fixes. Revisit as a deliberate refactor, not as
      // a condition of a green build. `rules-of-hooks`, `exhaustive-deps` and `refs`
      // stay on: those catch actual defects.
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  // --- tests: Vitest globals, and assertions that read oddly to core rules ---
  {
    files: ['**/*.test.{ts,tsx}', 'ui/src/test/**', 'ui/e2e/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // --- test fixtures: standalone node programs spawned by tests, not part of a package build ---
  {
    files: ['daemon/src/**/fixtures/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
  },

  // --- loose scripts: live smoke checks, run by hand against a real daemon ---
  {
    files: ['daemon/.smoke/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-useless-assignment': 'off',
    },
  },
);
