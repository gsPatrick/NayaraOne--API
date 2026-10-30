'use strict';

// Limpeza dos testes do briefing (M9-D693): apaga, na empresa de teste, o que a geração do briefing LÊ (painéis, indicadores, registros,
// briefings e parâmetros do briefing/IA). Roda ANTES dos testes (resto de outro arquivo no mesmo banco, por exemplo os painéis da
// M9-D687, vira item a mais no briefing) e DEPOIS do arquivo que grava com commit. Só banco descartável.
const SQL = [
  'DELETE FROM analytics.executive_briefs WHERE company_id = :c',
  "DELETE FROM analytics.access_log WHERE company_id = :c AND resource_type = 'BRIEF'",
  'DELETE FROM analytics.alert_instances WHERE company_id = :c',
  'DELETE FROM analytics.alert_definitions WHERE company_id = :c',
  'DELETE FROM analytics.dashboard_widgets WHERE dashboard_id IN (SELECT id FROM analytics.dashboard_definitions WHERE company_id = :c)',
  'DELETE FROM analytics.dashboard_definitions WHERE company_id = :c',
  'DELETE FROM analytics.metric_snapshots WHERE company_id = :c',
  'DELETE FROM analytics.metric_versions WHERE company_id = :c',
  'DELETE FROM analytics.metric_definitions WHERE company_id = :c',
  "DELETE FROM core.tenant_settings WHERE company_id = :c AND (key LIKE 'ia.%' OR key LIKE 'ai.%' OR key LIKE 'analytics.brief.%')",
];

async function purgeBriefResidue(env) {
  const c = env.tenantA.companyId;
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const sql of SQL) await env.admin.query(sql, { replacements: { c }, transaction });
  });
}

module.exports = { purgeBriefResidue };
