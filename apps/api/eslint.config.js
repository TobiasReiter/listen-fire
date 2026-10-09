const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');
const eslintPluginLocalRules = require('eslint-plugin-local-rules');
const airbnbTypescriptBase = require('eslint-config-airbnb-typescript');
const prettier = require('prettier');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'knip.ts',
      'src/generated/kysely/types.ts',
      // An older release's tests, verbatim — linted as that release's tree.
      'src/__conformance__/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin,
      'local-rules': eslintPluginLocalRules,
      prettier,
      airbnbTypescriptBase,
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/lines-between-class-members': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-use-before-define': ['error', { functions: false }],
      'arrow-body-style': 'off',
      camelcase: 'off',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'import/prefer-default-export': 'off',
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          warnOnUnassignedImports: true,
          groups: ['builtin', 'index', ['external', 'internal'], 'type', ['sibling', 'parent']],
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'time', 'timeEnd'] }],
      'no-restricted-syntax': ['off', { selector: 'ForOfStatement' }],
      'no-underscore-dangle': 'off',
      'import/extensions': 'off',
      'local-rules/bottom-exports': 'off',
      'local-rules/require-node-prefix': 'error',
    },
  },
  {
    files: ['**/*.resolvers.ts', '**/generated/**', 'src/interfaces/cli/commands/**', '**/*.tsx'],
    rules: {
      'local-rules/bottom-exports': 'off',
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    // Tests legitimately use `as any` / `as never` for mocks + fixtures; they
    // ship nothing. `any` stays strict everywhere else.
    files: ['**/__test__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The whole scripts tree is dev / ops / CI tooling, not shipped product —
    // console.log is its output and pragmatic casts (branded ids at CLI
    // boundaries, etc.) are fine here. Mirrors the test exemption above; these
    // are the "test and CI files" where disabling freely is acceptable.
    files: ['src/scripts/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The CLI prints its output to the console.
    files: ['src/interfaces/cli/**'],
    rules: {
      'no-console': 'off',
    },
  },
);
