'use strict';

// Lint da API (Guia §13 — etapa "lint" do CI). Regras recomendadas do ESLint, sem desligar
// nenhuma para esconder erro; só ajustes de ambiente (Node/CommonJS e node:test).
const js = require('@eslint/js');
const globals = require('globals');
const analyticsReadOnlyImports = require('./scripts/eslint-rules/analyticsReadOnlyImports');

module.exports = [
  { ignores: ['.claude/**', 'node_modules/**', 'uploads/**', 'backups/**', 'scratchpad/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  {
    // M9-D612 (BI-001): o BI não importa serviço de escrita de outros módulos.
    files: ['src/modules/analytics/**/*.js', 'src/features/analytics/**/*.js'],
    plugins: { nayara: { rules: { 'analytics-somente-leitura': analyticsReadOnlyImports } } },
    rules: { 'nayara/analytics-somente-leitura': 'error' },
  },
];
