'use strict';

// Lint da API (Guia §13 — etapa "lint" do CI). Regras recomendadas do ESLint, sem desligar
// nenhuma para esconder erro; só ajustes de ambiente (Node/CommonJS e node:test).
const js = require('@eslint/js');
const globals = require('globals');
const analyticsReadOnlyImports = require('./scripts/eslint-rules/analyticsReadOnlyImports');
const analyticsCamadas = require('./scripts/eslint-rules/analyticsCamadas');
const noFloatMoney = require('./scripts/eslint-rules/noFloatMoney');

const nayaraPlugin = { rules: { 'analytics-somente-leitura': analyticsReadOnlyImports, 'analytics-camadas': analyticsCamadas, 'no-float-money': noFloatMoney } };

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
    files: ['src/features/analytics/**/*.js'],
    plugins: { nayara: nayaraPlugin },
    rules: { 'nayara/analytics-somente-leitura': 'error' },
  },
  {
    // M9-D613: dependências entre as camadas do BI (fórmula pura; dashboards e briefs sem tabelas de origem).
    files: ['src/features/analytics/**/*.js'],
    plugins: { nayara: nayaraPlugin },
    rules: { 'nayara/analytics-camadas': 'error' },
  },
  {
    // M9-D605: fórmula pura, dinheiro em decimal, sem relógio nem sorteio.
    files: ['src/features/analytics/metrics/formulas/**/*.js'],
    plugins: { nayara: nayaraPlugin },
    rules: { 'nayara/no-float-money': 'error' },
  },
];
