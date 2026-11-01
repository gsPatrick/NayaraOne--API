'use strict';

// Higiene do estado analítico entre arquivos de teste que rodam no mesmo banco (M9 — hermeticidade). Só para banco descartável (admin).
// `limparMaterializacoes` apaga o que a agenda/worker materializa para as empresas dadas (read models rm_*, controle de aplicação, refreshes,
// checagens de qualidade e snapshots de métrica). Não toca definições de métrica nem dados-fonte: quem cria esses cuida do próprio `after`.

/** Tabelas rm_* do schema analytics que têm company_id (as tabelas rm_m9d* de teste não têm e são removidas por quem as cria). */
async function tabelasRm(admin, transaction) {
  const [rows] = await admin.query(
    `SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'analytics' AND c.column_name = 'company_id' AND t.table_type = 'BASE TABLE' AND c.table_name LIKE 'rm\\_%' ESCAPE '\\'`,
    { transaction },
  );
  return rows.map((r) => r.t);
}

async function limparMaterializacoes(admin, companyIds, { snapshots = true } = {}) {
  const ids = [].concat(companyIds);
  await admin.transaction(async (transaction) => {
    await admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of await tabelasRm(admin, transaction)) await admin.query(`DELETE FROM analytics."${t}" WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    for (const t of ['rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) await admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    if (snapshots) await admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
  });
}

module.exports = { limparMaterializacoes };
