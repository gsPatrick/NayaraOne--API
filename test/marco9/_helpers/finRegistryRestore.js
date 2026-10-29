'use strict';

// Restaura o registry de métricas de uma empresa ao estado de antes do teste (M9-D621, M9-D623).
// materializeFinanceKpis publica no nível da empresa TODOS os KPIs financeiros; sobras não CRITICAL (drilldown desligado) passam a ter precedência
// sobre a definição global e quebram os testes vizinhos (m9d712). Por isso o teste guarda os ids que existiam e apaga o resto.

/** Ids das definições de métrica que a empresa já tem (chamar antes de materializar). */
async function captureRegistry(admin, companyId) {
  const [rows] = await admin.query('SELECT id FROM analytics.metric_definitions WHERE company_id = :c', { replacements: { c: companyId } });
  return rows.map((r) => r.id);
}

/** Apaga snapshots, versões e definições da empresa que não existiam em `keepIds`, na transação recebida (já em modo replica). */
async function restoreRegistry(admin, transaction, companyId, keepIds) {
  const replacements = { c: companyId, keep: keepIds.length ? keepIds : ['00000000-0000-0000-0000-000000000000'] };
  const created = 'SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND id NOT IN (:keep)';
  await admin.query(`DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (${created})`, { replacements, transaction });
  await admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN (${created})`, { replacements, transaction });
  await admin.query(`UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE id IN (${created})`, { replacements, transaction });
  await admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c AND id NOT IN (:keep)', { replacements, transaction });
}

module.exports = { captureRegistry, restoreRegistry };
