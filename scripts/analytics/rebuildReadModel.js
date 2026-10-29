#!/usr/bin/env node
'use strict';

/**
 * M9-D608 — reconstrução (rebuild) de um read model do BI a partir das fontes.
 *   node scripts/analytics/rebuildReadModel.js --model=<rm_nome> --company=<id|all> --user=<id|email> [--motivo=<texto>]
 * Exige a permissão analytics:rebuild do usuário na empresa e o parâmetro analytics.rebuild.habilitado (LIGADO em LAB, DESLIGADO em produção).
 * Saída: hash e contagem de linhas antes e depois. Código de saída 0 = ok, 1 = falha, 2 = uso incorreto.
 */
const { runCli } = require('./rebuildCli');
const { sequelize } = require('../../src/models');
require('../../src/features/analytics'); // registra os read models do BI

runCli(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(`ERRO ${e.code || 'ANALYTICS_REBUILD_FAILED'}: ${e.message}`); process.exitCode = 1; })
  .finally(() => sequelize.close());
