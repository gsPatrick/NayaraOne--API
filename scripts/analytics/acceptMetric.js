#!/usr/bin/env node
'use strict';

/**
 * M9-D708 — aceite (ou rejeição) do owner sobre a reconciliação de um KPI do BI.
 *   node scripts/analytics/acceptMetric.js --metric=<código> --company=<id> --user=<id|email> --decisao=ACEITAR|REJEITAR --evidencia=<id do arquivo> [--versao=N] [--comentario=<texto>]
 * Exige a permissão analytics:accept e o papel de owner da métrica. Saída: 0 ok, 1 recusa, 2 uso incorreto.
 */
const { runAccept } = require('./acceptMetricCli');
const { sequelize } = require('../../src/models');
require('../../src/features/analytics');

runAccept(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(`ERRO ${e.code || 'ANALYTICS_ACCEPT_FAILED'}: ${e.message}`); process.exitCode = 1; })
  .finally(() => sequelize.close());
