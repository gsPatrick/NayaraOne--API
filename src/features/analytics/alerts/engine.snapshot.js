'use strict';

/**
 * M9-D691 (3.1 passo 2) — o valor que o alerta avalia: o snapshot mais recente da métrica no escopo da empresa (e da dimensão da definição),
 * com a freshness da M9-D609 e a qualidade da M9-D697 (check BLOCK falho, componente ruim). Métrica DEGRADED (inclui freshness EXPIRED), INCOMPLETE ou sem snapshot não dispara pelo valor: a definição
 * fica "em espera" nesta rodada (BI-015: indicador sem qualidade suficiente mostra incompleto, não valor enganoso).
 */
const { sequelize } = require('../../../models');
const clock = require('../metrics/clock');
const { computeFreshness, maxStalenessOf } = require('../metrics/freshness');
const { resolveStatus } = require('../metrics/freshness.present');
const { readFreshnessParams } = require('../metrics/freshness.settings');
const { assessQuality } = require('../quality/status.service');
const { worstStatus } = require('../quality/status.priority');

const BLOCKING = new Set(['DEGRADED', 'INCOMPLETE']);

async function metricRow(metricCode, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.id, d.domain FROM analytics.metric_definitions d WHERE d.metric_code = :code AND d.status <> 'RETIRED'
      ORDER BY (d.company_id IS NULL), (d.group_id IS NULL) LIMIT 1`,
    { replacements: { code: metricCode }, transaction }
  );
  return rows[0] || null;
}

/**
 * { hold: 'NO_METRIC' | 'NO_SNAPSHOT' | 'NOT_NUMERIC' | 'DEGRADED' | 'INCOMPLETE' } ou
 * { snapshot, previous, value, status, freshness, domain } com a leitura confiável.
 */
async function loadAlertInput(def, scope, { now = clock.now() } = {}, transaction) {
  const metric = await metricRow(def.metric_code, transaction);
  if (!metric) return { hold: 'NO_METRIC' };
  const dimensionKey = (def.scope && def.scope.dimensionKey) || '';
  const [rows] = await sequelize.query(
    `SELECT s.*, v.refresh_policy, v.version AS version_number FROM analytics.metric_snapshots s JOIN analytics.metric_versions v ON v.id = s.metric_version_id
      WHERE s.metric_id = :metricId AND s.scope_type = 'COMPANY' AND s.scope_id = :companyId AND s.dimension_key = :dimensionKey
        AND (CAST(:pin AS integer) IS NULL OR v.version = CAST(:pin AS integer))
      ORDER BY s.as_of_date DESC, s.revision_no DESC, s.refreshed_at DESC LIMIT 2`,
    { replacements: { metricId: metric.id, companyId: scope.companyId, dimensionKey, pin: def.metric_version_pin ?? null }, transaction }
  );
  const snapshot = rows[0];
  if (!snapshot) return { hold: 'NO_SNAPSHOT' };
  const params = await readFreshnessParams(scope, transaction);
  const freshness = computeFreshness({
    asOfDate: String(snapshot.as_of_date), sourceSnapshotAt: snapshot.source_snapshot_at, refreshedAt: snapshot.refreshed_at,
    maxStalenessMinutes: maxStalenessOf(snapshot.refresh_policy, metric.domain, params), factor: params.factor, now,
  });
  const assessed = await assessQuality({ metricCode: def.metric_code, scope, asOfDate: clock.businessToday(now), transaction }); // M9-D697: check BLOCK falho ou componente ruim
  const status = worstStatus(resolveStatus(snapshot.status, freshness.state), assessed.status);
  if (BLOCKING.has(status)) return { hold: status, snapshot, status, freshness };
  if (snapshot.value_numeric === null || snapshot.value_numeric === undefined) return { hold: 'NOT_NUMERIC', snapshot, status, freshness };
  return { snapshot, previous: rows[1] || null, value: String(snapshot.value_numeric), status, freshness, domain: metric.domain };
}

module.exports = { loadAlertInput };
