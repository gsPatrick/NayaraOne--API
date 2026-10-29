'use strict';

/**
 * M9-D712 (3.5) — semente única do registry: garante a definição de cada métrica da tabela de criticidade (idempotente por
 * `metric_code`) e publica a versão 1 PUBLISHED (criticidade e `value_nature` da tabela) quando a fórmula existe no catálogo do código e
 * o read model existe. Métrica sem fórmula ou sem read model fica DRAFT, nomeada em `pending` com o motivo; a demanda do KPI entrega a
 * fórmula e repete a semente. Chamada por migration de dados / script com `ctx = { actorUserId, permissions: ['analytics:manage'] }`.
 */
const { sequelize } = require('../../../../models');
const { businessDateKey } = require('../../../../utils/businessDate');
const clock = require('../clock');
const { getFormulaCatalog } = require('../formulaCatalog');
const { publishMetric } = require('../registry.service');
const { listCriticalityRows } = require('./criticality.table');
const { ensureDefinitions } = require('./seed.definitions');

const QUALITY_REFERENCE = 'Relatório de comparação do indicador com a fonte (M9-D708)';

function inputOf(row, validFrom) {
  return {
    scopeLevel: 'GLOBAL', metricCode: row.code, name: row.name, description: `${row.name} (${row.demand}).`, domain: row.domain,
    formulaId: row.formulaId, formulaSemantic: `Regra de cálculo de ${row.name}, definida na demanda ${row.demand}.`,
    sourceReadModel: row.sourceReadModel, dimensions: [...row.dimensions], filters: {}, unit: row.unit, ownerRole: row.ownerRole,
    refreshPolicy: { ...row.refreshPolicy }, version: 1, validFrom, qualityRule: { referenceReport: QUALITY_REFERENCE },
    valueNature: row.valueNature, criticality: row.criticality,
  };
}

async function readModelExists(name, transaction) {
  const [[r]] = await sequelize.query('SELECT to_regclass(:n) IS NOT NULL AS ok', { replacements: { n: `analytics.${name}` }, transaction });
  return r.ok;
}

async function currentVersionOf(code, transaction) {
  const [rows] = await sequelize.query(
    'SELECT current_version_id AS v FROM analytics.metric_definitions WHERE metric_code = :code AND company_id IS NULL AND group_id IS NULL',
    { replacements: { code }, transaction }
  );
  return rows[0] ? rows[0].v : null;
}

/** options: { catalog, rows, now } (injeção para teste). Devolve { created, published, existing, pending: [{ metricCode, reason }] }. */
async function seedMetricRegistry(ctx, transaction, options = {}) {
  const rows = options.rows || listCriticalityRows();
  const catalog = options.catalog || getFormulaCatalog();
  const validFrom = businessDateKey(options.now || clock.now());
  const run = async (sql, replacements) => (await sequelize.query(sql, { replacements, transaction }))[0];
  const created = await ensureDefinitions(run, rows);
  const out = { created, published: [], existing: [], pending: [] };
  for (const row of rows) {
    if (await currentVersionOf(row.code, transaction)) { out.existing.push(row.code); continue; }
    if (!catalog.has(row.formulaId)) { out.pending.push({ metricCode: row.code, reason: `fórmula ${row.formulaId} ainda não existe no código (${row.demand})` }); continue; }
    if (!(await readModelExists(row.sourceReadModel, transaction))) { out.pending.push({ metricCode: row.code, reason: `read model ${row.sourceReadModel} ainda não existe` }); continue; }
    await publishMetric(inputOf(row, validFrom), ctx, transaction, { catalog });
    out.published.push(row.code);
  }
  return out;
}

module.exports = { seedMetricRegistry };
