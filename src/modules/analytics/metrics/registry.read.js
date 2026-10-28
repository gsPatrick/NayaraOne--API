'use strict';

/**
 * M9-D603 (3.4, 4) — leitura do registro: lista, definição com histórico de versões e o valor PRONTO que a tela
 * recebe ({ value, unit, status, version, sourceSnapshotAt, refreshedAt, sourceRefs }). Nenhum cálculo aqui: o
 * valor vem do snapshot gravado pelo worker; o Front só formata.
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getLatestSnapshot } = require('../../../features/analytics/metricStore.service');
const { assertCanRead } = require('./registry.permission');
const { assertDomainAccess, loadDomainMap, domainPermissionOf, has } = require('../security');

const ORDER_SCOPE = 'ORDER BY (d.company_id IS NULL), (d.group_id IS NULL)';

/** Catálogo ativo (sem RETIRED, a menos que `includeRetired`). Uma linha por código, com a versão vigente. */
async function listRegistry(ctx, { domain = null, status = null, includeRetired = false } = {}, transaction) {
  assertCanRead(ctx);
  const [rows] = await sequelize.query(
    `SELECT d.metric_code AS "metricCode", d.name, d.domain, d.status, d.criticality, d.owner_role AS "ownerRole",
            v.unit, v.version, v.value_nature AS "valueNature", d.current_version_id AS "currentVersionId"
       FROM analytics.metric_definitions d LEFT JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE (:includeRetired OR d.status <> 'RETIRED')
        AND (CAST(:domain AS text) IS NULL OR d.domain = CAST(:domain AS text))
        AND (CAST(:status AS text) IS NULL OR d.status = CAST(:status AS text))
      ORDER BY d.metric_code, (d.company_id IS NULL), (d.group_id IS NULL)`,
    { replacements: { domain, status, includeRetired: includeRetired === true }, transaction }
  );
  // ABAC (M9-D700): só aparecem as métricas dos domínios cuja permissão de origem o usuário tem.
  const map = await loadDomainMap(ctx, transaction);
  return rows.filter((r) => has(ctx, domainPermissionOf(map, r.domain)));
}

async function findDefinition(code, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.* FROM analytics.metric_definitions d WHERE d.metric_code = :code ${ORDER_SCOPE} LIMIT 1`,
    { replacements: { code }, transaction }
  );
  if (!rows[0]) throw AppError.notFound('Métrica não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');
  return rows[0];
}

/** Definição + histórico de versões (mais nova primeiro). Métrica RETIRED continua legível. */
async function getMetric(ctx, metricCode, transaction) {
  assertCanRead(ctx);
  const definition = await findDefinition(metricCode, transaction);
  await assertDomainAccess(ctx, definition.domain, transaction);
  const [versions] = await sequelize.query(
    'SELECT * FROM analytics.metric_versions WHERE metric_id = :id ORDER BY version DESC',
    { replacements: { id: definition.id }, transaction }
  );
  return { definition, versions };
}

/** Valor pronto da métrica numa data-base (maior revisão do snapshot). 404 se não há snapshot. */
async function readMetricValue(ctx, { metricCode, scopeType, scopeId, asOfDate, dimensionKey = '' }, transaction) {
  assertCanRead(ctx);
  const definition = await findDefinition(metricCode, transaction);
  await assertDomainAccess(ctx, definition.domain, transaction);
  const snapshot = await getLatestSnapshot({ metricId: definition.id, scopeType, scopeId, asOfDate, dimensionKey }, transaction);
  if (!snapshot) throw AppError.notFound('Não há valor calculado para esta data.', 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
  const [[version]] = await sequelize.query('SELECT version, unit, value_nature FROM analytics.metric_versions WHERE id = :id', {
    replacements: { id: snapshot.metric_version_id }, transaction,
  });
  return {
    metricCode: definition.metric_code,
    value: snapshot.value_numeric != null ? String(snapshot.value_numeric) : snapshot.value_text,
    unit: version.unit,
    status: snapshot.status,
    version: version.version,
    valueNature: version.value_nature,
    asOfDate,
    revisionNo: snapshot.revision_no,
    sourceSnapshotAt: snapshot.source_snapshot_at,
    refreshedAt: snapshot.refreshed_at,
    sourceRefs: snapshot.source_refs,
  };
}

module.exports = { listRegistry, getMetric, readMetricValue, findDefinition };
