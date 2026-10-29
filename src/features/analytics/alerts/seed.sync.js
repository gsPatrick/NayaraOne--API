'use strict';

/**
 * M9-D691 (3.3) — materializa, por empresa, as definições dos alertas semente a partir dos parâmetros do administrador (seed.catalog.js). Idempotente:
 * a definição PUBLISHED igual ao parâmetro fica como está; se o administrador mudou limiar, severidade, tarefa ou o owner da métrica mudou, nasce a
 * versão seguinte PUBLISHED, a anterior vai para DISABLED e as instâncias abertas do limiar antigo são encerradas (DEFINITION_CHANGED). Definição semente
 * que o administrador desligou (última versão DISABLED e igual ao parâmetro) não volta sozinha. Owner: o da métrica; sem ele, `analytics.alert.owner_reserva`.
 * `create_task` só vale para CRITICAL (M9-D692). Cada alerta semente é avaliado pelo mesmo motor das demais definições.
 */
const { sequelize } = require('../../../models');
const { inCompany } = require('../companyTx');
const { readAlertParams } = require('./engine.settings');
const { SEEDS, FRESHNESS_METRIC_CODE } = require('./seed.catalog');
const { closeChangedInstances } = require('./engine.state');
const clock = require('../metrics/clock');
const { canonical } = require('./fingerprint');

async function ownerOf(metricCode, fallback, transaction) {
  const [rows] = await sequelize.query(
    `SELECT owner_role FROM analytics.metric_definitions WHERE metric_code = :metricCode AND owner_role IS NOT NULL AND length(btrim(owner_role)) > 0
      ORDER BY (company_id IS NULL), (group_id IS NULL) LIMIT 1`,
    { replacements: { metricCode }, transaction }
  );
  return rows[0] ? rows[0].owner_role : fallback;
}

async function desiredOf(seed, spec, params, transaction) {
  if (spec.kind === 'FRESHNESS') {
    return { metricCode: FRESHNESS_METRIC_CODE, threshold: { operator: 'GT', value: 0 }, scope: { kind: 'FRESHNESS' }, severity: spec.severity, ownerRole: params.ownerFallback, createTask: false };
  }
  return {
    metricCode: spec.metricCode, threshold: { operator: spec.operator, value: spec.value }, scope: spec.dimensionKey ? { dimensionKey: spec.dimensionKey } : {},
    severity: spec.severity, ownerRole: await ownerOf(spec.metricCode, params.ownerFallback, transaction), createTask: spec.createTask && spec.severity === 'CRITICAL',
  };
}

const same = (row, d) => row.metric_code === d.metricCode && row.severity === d.severity && row.owner_role === d.ownerRole && row.create_task === d.createTask
  && canonical(row.threshold) === canonical(d.threshold) && canonical(row.scope) === canonical(d.scope); // jsonb reordena as chaves: compara na forma canônica

async function syncOne(seed, spec, params, scope, now, transaction) {
  const desired = await desiredOf(seed, spec, params, transaction);
  const [rows] = await sequelize.query(
    'SELECT * FROM analytics.alert_definitions WHERE company_id = :companyId AND alert_code = :alertCode ORDER BY version DESC FOR UPDATE',
    { replacements: { companyId: scope.companyId, alertCode: seed.alertCode }, transaction }
  );
  const latest = rows[0];
  const published = rows.find((r) => r.status === 'PUBLISHED');
  if (published && same(published, desired)) return 'KEPT';
  if (!published && latest && latest.status === 'DISABLED' && same(latest, desired)) return 'DISABLED_BY_ADMIN';
  if (published) {
    await sequelize.query("UPDATE analytics.alert_definitions SET status = 'DISABLED', updated_at = now() WHERE id = :id", { replacements: { id: published.id }, transaction });
    await closeChangedInstances(published, scope, null, now, transaction);
  }
  await sequelize.query(
    `INSERT INTO analytics.alert_definitions
       (company_id, group_id, alert_code, metric_code, condition_type, threshold, severity, owner_role, auto_resolve_policy, scope, create_task, status, version, published_at)
     VALUES (:companyId, :groupId, :alertCode, :metricCode, 'THRESHOLD', CAST(:threshold AS jsonb), :severity, :ownerRole, '{}'::jsonb, CAST(:scope AS jsonb), :createTask,
             'PUBLISHED', :version, :now)`,
    {
      replacements: {
        companyId: scope.companyId, groupId: scope.groupId, alertCode: seed.alertCode, metricCode: desired.metricCode, threshold: JSON.stringify(desired.threshold),
        severity: desired.severity, ownerRole: desired.ownerRole, scope: JSON.stringify(desired.scope), createTask: desired.createTask, version: latest ? latest.version + 1 : 1, now,
      },
      transaction,
    }
  );
  return latest ? 'VERSIONED' : 'CREATED';
}

/** Sincroniza os alertas semente da empresa. Devolve { alertCode: 'CREATED' | 'VERSIONED' | 'KEPT' | 'DISABLED_BY_ADMIN' }. */
async function syncSeedAlerts(scope, { now = clock.now() } = {}) {
  const params = await inCompany(scope, (tx) => readAlertParams(scope, tx));
  const out = {};
  for (const seed of SEEDS) {
    out[seed.alertCode] = await inCompany(scope, (tx) => syncOne(seed, params.seeds[seed.key], params, scope, now, tx));
  }
  return out;
}

module.exports = { syncSeedAlerts };
