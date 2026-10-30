'use strict';

/**
 * M9-D652 / M9-D653 — fábrica de um grupo de KPIs do BI: dado o grupo (definições do registry e a função `build` que lê os read models e devolve, por KPI,
 * entrada da fórmula, parâmetros, filtro de origem e instante da fonte), entrega o que todo grupo faz do mesmo jeito: publicar a versão 1 no registry da
 * empresa (idempotente), calcular com a fórmula versionada do código, montar as entradas do snapshot (principal + dimensões, com hash do cálculo e
 * sourceRefs, M9-D611), gravar na transação do refresh (escritor do BI ligado), ligar ao fim do lote de refresh dos read models observados e fornecer
 * o provedor do snapshot diário (M9-D609). Os read models não guardam histórico: o provedor só calcula o dia de hoje, nada é inventado para o passado.
 * KPI que `build` não devolve (read model ainda sem dado na data) não gera snapshot e sai INCOMPLETE na leitura.
 */
const AppError = require('../../../../utils/AppError');
const logger = require('../../../../utils/logger');
const { sequelize } = require('../../../../models');
const store = require('../../metricStore.service');
const clock = require('../clock');
const { getFormulaCatalog } = require('../formulaCatalog');
const { runFormula } = require('../formulaRun');
const { calcHash } = require('../calcHash');
const { buildSourceRefs } = require('../sourceRefs.build');
const { publishMetric } = require('../registry.service');
const { registerSnapshotProvider } = require('../snapshots.providers');
const { onBatchFlushed } = require('../../read-models');
const { P } = require('../../security/permissionCatalog');
const { writeSnapshotInputs } = require('./finance.snapshots');

const workerCtx = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId, actorUserId: null, permissions: [P.MANAGE] });
const snapshotInputs = (base, result) => [
  { ...base, dimensionKey: '', valueNumeric: result.value },
  ...(result.dimensions || []).map((d) => ({ ...base, dimensionKey: d.key, valueNumeric: d.value })),
];

async function isPublished(code, scope, transaction) {
  const [rows] = await sequelize.query(
    "SELECT 1 FROM analytics.metric_definitions WHERE metric_code = :code AND company_id = :companyId AND status = 'PUBLISHED' AND current_version_id IS NOT NULL LIMIT 1",
    { replacements: { code, companyId: scope.companyId }, transaction }
  );
  return rows.length > 0;
}

async function publishedVersion(code, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.id AS "metricId", v.id AS "metricVersionId", v.version, v.unit FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code AND d.company_id = :companyId AND d.status = 'PUBLISHED'`, { replacements: { code, companyId }, transaction });
  return rows[0];
}

/** group: { name, definitions, publishInput(def, scope, tx), build(scope, asOfDate, tx), watched: [read models], getReadModelVersion(name) }. */
function createKpiGroup(group) {
  async function ensurePublished(scope, transaction) {
    for (const def of group.definitions) {
      if (await isPublished(def.metricCode, scope, transaction)) continue;
      try {
        await sequelize.transaction({ transaction }, async (savepoint) => publishMetric(await group.publishInput(def, scope, savepoint), workerCtx(scope), savepoint));
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'ANALYTICS_METRIC_CODE_DUPLICATE') throw err;
      }
    }
  }

  /** [{ code, result, inputs }] de cada KPI publicado cujo read model tem dado. */
  async function buildEntries(scope, asOfDate, transaction) {
    const built = await group.build(scope, asOfDate, transaction);
    const sourceCtx = { groupId: scope.groupId, companyId: scope.companyId, permissions: [P.READ] };
    const catalog = getFormulaCatalog();
    const out = [];
    for (const def of group.definitions) {
      const item = built[def.metricCode];
      const published = item && await publishedVersion(def.metricCode, scope.companyId, transaction);
      if (!published) continue;
      const result = runFormula(catalog.get(def.metricCode), item.inputs, item.params || {});
      const { sourceRefs } = await buildSourceRefs(sourceCtx, def.metricCode, { filter: item.filter, unit: published.unit }, transaction);
      const base = {
        metricId: published.metricId, metricVersionId: published.metricVersionId, groupId: scope.groupId, companyId: scope.companyId, scopeType: 'COMPANY', scopeId: scope.companyId,
        periodStart: item.periodStart || asOfDate, periodEnd: asOfDate, asOfDate, status: result.status, sourceSnapshotAt: item.snapshotAt, readModelVersion: group.readModelVersion(def.sourceReadModel),
        sourceRefs, calcHash: calcHash({ metricCode: def.metricCode, version: published.version, inputs: item.inputs, params: item.params || {} }),
      };
      out.push({ code: def.metricCode, result, inputs: snapshotInputs(base, result) });
    }
    return out;
  }

  /** Calcula e grava os snapshots da data-base na transação dada; só entra revisão se algo mudou. Devolve { kpis, written }. */
  async function materialize(scope, asOfDate, transaction) {
    await store.enableAnalyticsWriter(transaction);
    await ensurePublished(scope, transaction);
    const out = { kpis: {}, written: 0 };
    for (const entry of await buildEntries(scope, asOfDate, transaction)) {
      out.written += await writeSnapshotInputs(entry.inputs, transaction);
      out.kpis[entry.code] = entry.result;
    }
    return out;
  }

  async function onFlushed(entry, transaction) {
    if (!group.watched.includes(entry.readModel)) return;
    try {
      await sequelize.transaction({ transaction }, async (savepoint) => { await materialize({ companyId: entry.companyId, groupId: entry.groupId }, clock.businessToday(), savepoint); });
    } catch (err) {
      logger.error({ event: `analytics.kpi.${group.name}_failed`, companyId: entry.companyId, err }, `[analytics] não foi possível calcular os KPIs ${group.name} do refresh`);
    }
  }

  let installed = false;
  const install = () => { if (!installed) { installed = true; onBatchFlushed(onFlushed); } };

  const provider = {
    name: `${group.name}-kpis`,
    metricCodes: group.definitions.map((d) => d.metricCode),
    async build(scope, asOfDate, transaction) {
      if (asOfDate !== clock.businessToday()) return [];
      return (await buildEntries(scope, asOfDate, transaction)).map((e) => ({ code: e.code, inputs: e.inputs }));
    },
  };

  return { definitions: group.definitions, ensurePublished, buildEntries, materialize, onFlushed, install, provider, registerProvider: () => registerSnapshotProvider(provider) };
}

module.exports = { createKpiGroup };
