'use strict';

/**
 * DI-BI-2 (M9-D609) — confirmação do valor principal de um snapshot. O snapshot é imutável (M9-D600) e o recálculo que dá o mesmo valor, status e hash não grava nada;
 * por isso o `source_snapshot_at` do snapshot é o do PRIMEIRO cálculo. Cada refresh que relê a fonte e chega ao mesmo resultado registra aqui o instante da fonte
 * (`source_confirmed_at`), e a freshness passa a medir a idade a partir da leitura mais recente que confirmou o número: um indicador que não muda (zero erros o dia todo)
 * continua fresco enquanto a fonte for relida, e envelhece de verdade quando o refresh para. Só o valor principal (dimensão vazia) é confirmado: é dele que sai a freshness.
 */
const { sequelize } = require('../../../models');

/** Registra que `snapshot` (linha de metric_snapshots) foi confirmado pela leitura da fonte em `sourceAt`. Na transação do refresh (escritor do BI ligado). */
async function confirmSnapshot(snapshot, sourceAt, transaction) {
  if (!snapshot || !snapshot.id || !sourceAt || snapshot.dimension_key !== '' || !snapshot.company_id) return false;
  await sequelize.query(
    `INSERT INTO analytics.metric_snapshot_confirmations (snapshot_id, company_id, group_id, metric_id, source_confirmed_at, confirmed_at)
     VALUES (:id, :companyId, :groupId, :metricId, :at, clock_timestamp())
     ON CONFLICT (snapshot_id) DO UPDATE SET
       source_confirmed_at = GREATEST(analytics.metric_snapshot_confirmations.source_confirmed_at, EXCLUDED.source_confirmed_at),
       confirmed_at = EXCLUDED.confirmed_at, confirmations = analytics.metric_snapshot_confirmations.confirmations + 1`,
    { replacements: { id: snapshot.id, companyId: snapshot.company_id, groupId: snapshot.group_id, metricId: snapshot.metric_id, at: sourceAt }, transaction }
  );
  return true;
}

const later = (a, b) => (!a ? b : !b ? a : new Date(a).getTime() >= new Date(b).getTime() ? a : b);

/**
 * { sourceSnapshotAt, refreshedAt, confirmedAt } que a freshness deve usar: o instante da fonte mais recente entre o do snapshot e o da última confirmação, e o instante
 * em que essa leitura foi gravada. Sem confirmação, os do próprio snapshot.
 */
async function effectiveTimes(snapshot, transaction) {
  const own = { sourceSnapshotAt: snapshot.source_snapshot_at, refreshedAt: snapshot.refreshed_at, confirmedAt: null };
  if (!snapshot.id || snapshot.dimension_key !== '' || !snapshot.source_snapshot_at) return own;
  const [rows] = await sequelize.query(
    'SELECT source_confirmed_at, confirmed_at FROM analytics.metric_snapshot_confirmations WHERE snapshot_id = :id',
    { replacements: { id: snapshot.id }, transaction }
  );
  const c = rows[0];
  if (!c || new Date(c.source_confirmed_at).getTime() <= new Date(snapshot.source_snapshot_at).getTime()) return own;
  return { sourceSnapshotAt: later(snapshot.source_snapshot_at, c.source_confirmed_at), refreshedAt: later(snapshot.refreshed_at, c.confirmed_at), confirmedAt: c.source_confirmed_at };
}

/** Trecho de SQL: o instante da fonte confirmado para o snapshot de alias `s` (usar com LEFT JOIN ... c ON c.snapshot_id = s.id). */
const CONFIRMED_SOURCE_SQL = 'GREATEST(s.source_snapshot_at, c.source_confirmed_at)';
const CONFIRMED_REFRESHED_SQL = 'GREATEST(s.refreshed_at, c.confirmed_at)';
const CONFIRMATION_JOIN_SQL = "LEFT JOIN analytics.metric_snapshot_confirmations c ON c.snapshot_id = s.id AND s.dimension_key = ''";

module.exports = { confirmSnapshot, effectiveTimes, CONFIRMED_SOURCE_SQL, CONFIRMED_REFRESHED_SQL, CONFIRMATION_JOIN_SQL };
