#!/usr/bin/env node
'use strict';

/**
 * M9-D708 — reconciliação dos KPIs do BI com os relatórios de referência.
 *   node scripts/analytics/reconcile.js --metric=<código|all> --company=<id> [--data=AAAA-MM-DD]
 * Grava em analytics.metric_acceptance (PENDING) o valor do BI, o do relatório e a diferença; o aceite é do owner (acceptMetric.js).
 * Saída: 0 ok, 1 falha, 2 uso incorreto.
 */
const { runReconcile } = require('./reconcileCli');
const { sequelize } = require('../../src/models');
require('../../src/features/analytics'); // registra os read models, KPIs e origens do BI

runReconcile(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(`ERRO ${e.code || 'ANALYTICS_RECONCILE_FAILED'}: ${e.message}`); process.exitCode = 1; })
  .finally(() => sequelize.close());
