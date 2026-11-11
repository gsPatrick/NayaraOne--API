'use strict';

/**
 * M9-D660 / M9-D661 — maquinário comum dos conjuntos de KPIs do Jurídico e do Correspondente: dado o conjunto (definições, leitura dos read models,
 * entradas e parâmetros de cada fórmula, filtros de origem), monta o resultado de cada KPI da empresa e as entradas de snapshot (principal + dimensões),
 * publica o KPI no registry (versão 1, idempotente), grava o snapshot na transação do refresh, liga o cálculo ao fim de cada lote de refresh dos read
 * models e fornece o snapshot diário (M9-D609). A fonte é sempre o estado atual do read model: KPI cujo read model nunca foi alimentado não gera
 * snapshot (sem fonte não há número). Falha no refresh nunca derruba a projeção: vai para o log e o KPI segue com o snapshot anterior.
 */
const AppError = require('../../../../../utils/AppError');
const logger = require('../../../../../utils/logger');
const { sequelize } = require('../../../../../models');
const store = require('../../../metricStore.service');
const { publishMetric } = require('../../registry.service');
const { getFormulaCatalog } = require('../../formulaCatalog');
const { calcHash } = require('../../calcHash');
const { runFormula } = require('../../formulaRun');
const { buildSourceRefs } = require('../../sourceRefs.build');
const clock = require('../../clock');
const { registerSnapshotProvider } = require('../../snapshots.providers');
const { onBatchFlushed, getReadModel } = require('../../../read-models');
const { P } = require('../../../security/permissionCatalog');
const { writeSnapshotInputs } = require('../finance.snapshots');
const { upgradeDeclaredVersion } = require('./kpiUpgrade');

const workerCtx = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId, actorUserId: null, permissions: [P.MANAGE] });

async function publishedVersion(code, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.id AS "metricId", v.id AS "metricVersionId", v.version, v.unit FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code AND d.company_id = :companyId AND d.status = 'PUBLISHED'`, { replacements: { code, companyId }, transaction });
  return rows[0];
}

async function isPublished(code, scope, transaction) {
  const [rows] = await sequelize.query(
    "SELECT 1 FROM analytics.metric_definitions WHERE metric_code = :code AND company_id = :companyId AND status = 'PUBLISHED' AND current_version_id IS NOT NULL LIMIT 1",
    { replacements: { code, companyId: scope.companyId }, transaction }
  );
  return rows.length > 0;
}

/** Uma entrada por snapshot: o valor principal (dimensão vazia) e uma por dimensão que a fórmula devolve. */
const snapshotInputs = (base, result) => [
  { ...base, dimensionKey: '', valueNumeric: result.value },
  ...(result.dimensions || []).map((d) => ({ ...base, dimensionKey: d.key, valueNumeric: d.value })),
];

/**
 * set = { name, definitions, readOwner(code, scope, tx), readParams(scope, tx), loadRows(scope, asOfDate, tx) -> { snapshotAt: { código: Date|null }, ... },
 * inputs: { código: (rows, ctx) }, params: { código: (settings) }, filterOf(code, asOfDate, settings, { snapshotAt }) -> filtro de origem, periodStart(asOfDate),
 * watched: [nomes dos read models], sourceSpecs: módulo que registra as origens }
 */
function createKpiSet(set) {
  const { definitions } = set;

  async function ensurePublished(scope, transaction) {
    for (const def of definitions) {
      if (await isPublished(def.metricCode, scope, transaction)) {
        await upgradeDeclaredVersion(def, scope, workerCtx(scope), transaction); // DI-BI-3: versão declarada no código acima da publicada
        continue;
      }
      try {
        await sequelize.transaction({ transaction }, async (savepoint) => {
          const input = { ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', formulaId: def.metricCode, ownerRole: await set.readOwner(def.metricCode, scope, savepoint) };
          return publishMetric(input, workerCtx(scope), savepoint);
        });
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'ANALYTICS_METRIC_CODE_DUPLICATE') throw err;
      }
    }
  }

  /** Devolve [{ code, result, inputs }] (um por KPI publicado na empresa cujo read model já foi alimentado). */
  async function buildEntries(scope, asOfDate, transaction) {
    const settings = await set.readParams(scope, transaction);
    const rows = await set.loadRows(scope, asOfDate, settings, transaction);
    const sourceCtx = { groupId: scope.groupId, companyId: scope.companyId, permissions: [P.READ] };
    const catalog = getFormulaCatalog();
    const out = [];
    for (const def of definitions) {
      const published = await publishedVersion(def.metricCode, scope.companyId, transaction);
      const snapshotAt = rows.snapshotAt[def.metricCode];
      if (!published || !snapshotAt) continue;
      const inputs = set.inputs[def.metricCode](rows, { asOfDate, settings });
      const params = set.params[def.metricCode] ? set.params[def.metricCode](settings) : {};
      const result = runFormula(catalog.get(def.metricCode), inputs, params);
      const filter = set.filterOf(def.metricCode, asOfDate, settings, { snapshotAt }); // DI-BI-7: o instante do read model, para a origem que depende da hora
      const { sourceRefs } = await buildSourceRefs(sourceCtx, def.metricCode, { filter, unit: published.unit }, transaction);
      const base = {
        metricId: published.metricId, metricVersionId: published.metricVersionId, groupId: scope.groupId, companyId: scope.companyId, scopeType: 'COMPANY', scopeId: scope.companyId,
        periodStart: set.periodStart(asOfDate), periodEnd: asOfDate, asOfDate, status: result.status, sourceSnapshotAt: snapshotAt, readModelVersion: getReadModel(def.sourceReadModel).version,
        sourceRefs, calcHash: calcHash({ metricCode: def.metricCode, version: published.version, inputs, params }),
      };
      out.push({ code: def.metricCode, result, inputs: snapshotInputs(base, result) });
    }
    return out;
  }

  /** Calcula os KPIs da empresa e grava o snapshot da data-base (só entra revisão se algo mudou). Devolve { kpis: { código: resultado }, written }. */
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

  const watched = new Set(set.watched);
  async function onFlushed(entry, transaction) {
    if (!watched.has(entry.readModel)) return;
    try {
      await sequelize.transaction({ transaction }, async (savepoint) => {
        await materialize({ companyId: entry.companyId, groupId: entry.groupId }, clock.businessToday(), savepoint);
      });
    } catch (err) {
      logger.error({ event: `analytics.kpi.${set.name}_failed`, companyId: entry.companyId, err }, `[analytics] não foi possível calcular os KPIs de ${set.name} do refresh`);
    }
  }

  let installed = false;
  const install = () => {
    if (installed) return;
    installed = true;
    onBatchFlushed(onFlushed);
  };

  // Os read models não guardam histórico (M9-D604): o estado só serve para hoje; para uma data anterior vale o último snapshot gravado ao vivo.
  const provider = {
    name: `${set.name}-kpis`,
    metricCodes: definitions.map((d) => d.metricCode),
    async build(scope, asOfDate, transaction) {
      if (asOfDate !== clock.businessToday()) return [];
      return (await buildEntries(scope, asOfDate, transaction)).map((e) => ({ code: e.code, inputs: e.inputs }));
    },
  };

  return { definitions, ensurePublished, buildEntries, materialize, install, onFlushed, provider, registerProvider: () => registerSnapshotProvider(provider) };
}

module.exports = { createKpiSet };
