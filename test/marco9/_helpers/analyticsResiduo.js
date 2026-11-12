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

/** Colunas do schema analytics que apontam para definição, versão ou snapshot de métrica (fora as duas tabelas da própria métrica). */
async function colunasDeMetrica(admin, transaction) {
  const [cols] = await admin.query(
    `SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'analytics' AND t.table_type = 'BASE TABLE' AND c.column_name IN ('metric_id', 'metric_version_id', 'snapshot_id', 'metric_snapshot_id', 'metric_code')
        AND c.table_name NOT IN ('metric_definitions', 'metric_versions', 'metric_snapshots')`,
    { transaction },
  );
  return cols;
}

/**
 * Apaga definições de métrica (pelos ids) e tudo o que aponta para elas no schema analytics: snapshots, revisões, confirmações, versões, aceites e o que
 * mais tiver metric_id, metric_version_id ou snapshot_id; `metric_code` só nas linhas da mesma empresa da definição. Gatilhos de imutabilidade desligados
 * só nesta transação. Só banco descartável (admin).
 */
async function removerDefinicoes(admin, definitionIds) {
  const metricIds = [...new Set([].concat(definitionIds))].filter(Boolean);
  if (!metricIds.length) return;
  await admin.transaction(async (transaction) => {
    await admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const q = async (sql, replacements) => (await admin.query(sql, { replacements, transaction }))[0];
    const defs = await q('SELECT id, metric_code, company_id FROM analytics.metric_definitions WHERE id IN (:metricIds)', { metricIds });
    const versionIds = (await q('SELECT id FROM analytics.metric_versions WHERE metric_id IN (:metricIds)', { metricIds })).map((v) => v.id);
    const snapshotIds = (await q('SELECT id FROM analytics.metric_snapshots WHERE metric_id IN (:metricIds)', { metricIds })).map((v) => v.id);
    const alvo = { metric_id: metricIds, metric_version_id: versionIds, snapshot_id: snapshotIds, metric_snapshot_id: snapshotIds };
    for (const { t, c } of await colunasDeMetrica(admin, transaction)) {
      if (c === 'metric_code') {
        const [[temEmpresa]] = await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t AND column_name = 'company_id'`, { replacements: { t }, transaction });
        for (const d of defs) {
          if (temEmpresa.n && d.company_id) await q(`DELETE FROM analytics."${t}" WHERE metric_code = :code AND company_id = :c`, { code: d.metric_code, c: d.company_id });
          else if (!d.company_id) await q(`DELETE FROM analytics."${t}" WHERE metric_code = :code${temEmpresa.n ? ' AND company_id IS NULL' : ''}`, { code: d.metric_code });
        }
      } else if (alvo[c].length) await q(`DELETE FROM analytics."${t}" WHERE "${c}" IN (:ids)`, { ids: alvo[c] });
    }
    await q('DELETE FROM analytics.metric_snapshots WHERE metric_id IN (:metricIds)', { metricIds });
    await q('DELETE FROM analytics.metric_versions WHERE metric_id IN (:metricIds)', { metricIds });
    await q('DELETE FROM analytics.metric_definitions WHERE id IN (:metricIds)', { metricIds });
  });
}

/**
 * Apaga as definições de métrica criadas por um arquivo de teste pelo código (único por chamada, como os `*.m9d600_*`) e o que aponta para elas.
 * A definição GLOBAL ou de grupo que sobra entra no catálogo de todas as empresas e muda a contagem de outro arquivo (m9d712.tabela, m9d712.semente).
 */
async function removerMetricasPorCodigo(admin, codes) {
  const lista = [...new Set([].concat(codes))].filter(Boolean);
  if (!lista.length) return;
  const [defs] = await admin.query('SELECT id FROM analytics.metric_definitions WHERE metric_code IN (:lista)', { replacements: { lista } });
  await removerDefinicoes(admin, defs.map((d) => d.id));
}

/** Ids das definições de métrica por empresa que existem agora (para o arquivo apagar no fim só as que ele fez nascer em empresas que não são dele). */
async function definicoesPorEmpresa(admin) {
  const [rows] = await admin.query('SELECT id FROM analytics.metric_definitions WHERE company_id IS NOT NULL');
  return new Set(rows.map((r) => r.id));
}

/** Apaga as definições de empresa criadas depois de `antes` (Set de ids), fora das empresas `exceto` (que o próprio teardown do arquivo apaga). */
async function removerDefinicoesNovas(admin, antes, exceto = []) {
  const [rows] = await admin.query('SELECT id, company_id FROM analytics.metric_definitions WHERE company_id IS NOT NULL');
  const fora = new Set(exceto);
  await removerDefinicoes(admin, rows.filter((r) => !antes.has(r.id) && !fora.has(r.company_id)).map((r) => r.id));
}

module.exports = { limparMaterializacoes, removerDefinicoes, removerMetricasPorCodigo, definicoesPorEmpresa, removerDefinicoesNovas };
