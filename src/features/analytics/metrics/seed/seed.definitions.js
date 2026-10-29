'use strict';

/**
 * M9-D712 (3.1, 3.2, 3.5) — grava no catálogo global as definições das métricas da tabela de criticidade, com criticidade e drill-down
 * exatos da tabela (CRITICAL liga `drilldown_enabled`). Idempotente por `metric_code`: quem já existe não é tocado. Só SQL: serve à
 * migration de dados (sem carregar o app) e ao serviço de semente. `run(sql, replacements)` devolve as linhas do SELECT/RETURNING.
 */
const { listCriticalityRows } = require('./criticality.table');

const INSERT = `
  INSERT INTO analytics.metric_definitions (metric_code, name, description, domain, status, criticality, drilldown_enabled, owner_role, group_scoped)
  SELECT :code, :name, :description, :domain, 'DRAFT', :criticality, :drilldown, :ownerRole, false
   WHERE NOT EXISTS (SELECT 1 FROM analytics.metric_definitions WHERE metric_code = :code AND company_id IS NULL AND group_id IS NULL)
  RETURNING metric_code`;

const describe = (row) => `${row.name}. Regra de cálculo, texto e exemplos na demanda ${row.demand}; classificação ${row.criticality} (${row.reason}).`;

/** Devolve os códigos criados nesta chamada (os que já existiam ficam de fora). */
async function ensureDefinitions(run, rows = listCriticalityRows()) {
  await run("SELECT set_config('app.analytics_writer', 'on', true)", {});
  const created = [];
  for (const row of rows) {
    const out = await run(INSERT, {
      code: row.code, name: row.name, description: describe(row), domain: row.domain, criticality: row.criticality,
      drilldown: row.criticality === 'CRITICAL', ownerRole: row.ownerRole,
    });
    if (out.length) created.push(row.code);
  }
  return created;
}

module.exports = { ensureDefinitions, describe };
