#!/usr/bin/env node
'use strict';

/**
 * M9-D712 — repete a semente do registry de métricas do BI (idempotente por metric_code): garante as 90 definições da tabela de
 * criticidade e publica a versão 1 de cada métrica cuja fórmula já existe no código e cujo read model existe.
 *   node scripts/analytics/seedMetricRegistry.js
 * Saída: criadas, publicadas, já existentes e pendentes (com o motivo). Código 0 = ok, 1 = falha.
 */
const { sequelize } = require('../../src/models');
const { seedMetricRegistry } = require('../../src/features/analytics/metrics/seed');

async function main() {
  const result = await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction });
    return seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, transaction);
  });
  console.log(`criadas: ${result.created.length}; publicadas: ${result.published.length}; já existentes: ${result.existing.length}; pendentes: ${result.pending.length}`);
  for (const p of result.pending) console.log(`  pendente ${p.metricCode}: ${p.reason}`);
}

main().catch((e) => { console.error(`ERRO ${e.code || 'ANALYTICS_SEED_FAILED'}: ${e.message}`); process.exitCode = 1; }).finally(() => sequelize.close());
