#!/usr/bin/env node
'use strict';

/**
 * M9-D699 (3.1) — massa de carga do BI, determinística por semente: várias empresas, histórico de 24 meses e volume de lançamentos, transações
 * bancárias, oportunidades, imóveis e eventos de obra (etapas, medições, relatórios diários). Mesma semente, âncora e tamanhos = mesmas linhas
 * (mesmo digest). O tamanho é fixture do teste (grande o bastante para o painel lendo o OLTP degradar o fluxo operacional), não meta de desempenho.
 * SÓ em banco descartável (scripts/withDisposableDb.js). Uso: node scripts/analytics/seedLoad.js [--seed 42] [--scale light|full] [--companies 3]
 */
const { TABLES, DIGEST_COLUMNS } = require('./load/seed.sql');
const { sizesFor, requireDisposable } = require('./load/seed.sizes');

const uuidSql = "CAST(md5(CAST(:seed AS text) || ':company:' || :n) AS uuid)";

function connect(adminUrl = process.env.DATABASE_ADMIN_URL) {
  requireDisposable(adminUrl);
  const { Sequelize } = require('sequelize');
  return new Sequelize(adminUrl, { dialect: 'postgres', logging: false });
}

async function inReplica(admin, fn) {
  return admin.transaction(async (transaction) => {
    await admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    return fn(transaction);
  });
}

/** Grupo e empresas da massa. A 1ª empresa é a do rebuild sob carga (não recebe escrita do fluxo operacional). */
async function ensureCompanies(admin, { seed, companies }, groupId, transaction) {
  const out = [];
  for (let n = 1; n <= companies; n += 1) {
    const [[row]] = await admin.query(`SELECT ${uuidSql} AS id`, { replacements: { seed, n }, transaction });
    await admin.query(
      'INSERT INTO core.companies (id, group_id, name) VALUES (:id, :groupId, :name) ON CONFLICT (id) DO NOTHING',
      { replacements: { id: row.id, groupId, name: `M9 CARGA ${seed}-${n}` }, transaction }
    );
    out.push({ companyId: row.id, groupId });
  }
  return out;
}

async function digestOf(admin, companyIds) {
  const parts = [];
  for (const t of TABLES) {
    const cols = DIGEST_COLUMNS[t.table];
    const [[row]] = await admin.query(
      `SELECT count(*)::int AS n, COALESCE(md5(string_agg(md5(CAST(ROW(${cols}) AS text)), '' ORDER BY id)), '') AS h FROM ${t.table} WHERE company_id IN (:ids)`,
      { replacements: { ids: companyIds } }
    );
    parts.push(`${t.table}:${row.n}:${row.h}`);
  }
  return { digest: require('node:crypto').createHash('sha256').update(parts.join('|')).digest('hex'), perTable: parts };
}

/** Grava a massa. Devolve { companies, sizes, rows, digest }. `groupId` omitido = o grupo da empresa fictícia A do seed do CI. */
async function seedLoad(admin, options = {}) {
  const sizes = sizesFor(options);
  const anchor = options.anchor || new Date().toISOString().slice(0, 10);
  const [[g]] = await admin.query("SELECT group_id AS id FROM core.companies WHERE name <> '' ORDER BY created_at LIMIT 1");
  const groupId = options.groupId || g.id;
  const days = sizes.months * 30;
  const companies = await inReplica(admin, (transaction) => ensureCompanies(admin, sizes, groupId, transaction));
  const rows = {};
  await inReplica(admin, async (transaction) => {
    for (const { companyId } of companies) {
      for (const t of TABLES) {
        const n = sizes[t.count];
        await admin.query(`DELETE FROM ${t.table} WHERE company_id = :cid`, { replacements: { cid: companyId }, transaction });
        await admin.query(t.sql, { replacements: { seed: sizes.seed, anchor, gid: groupId, cid: companyId, days, n, projects: sizes.projects, stages: sizes.stages }, transaction });
        rows[t.table] = (rows[t.table] || 0) + n;
      }
    }
  });
  const { digest } = await digestOf(admin, companies.map((c) => c.companyId));
  return { companies, sizes, anchor, rows, digest };
}

/** Apaga tudo o que a massa e a execução de carga gravaram para as empresas (leituras do BI incluídas). */
async function cleanupLoad(admin, companies) {
  const ids = companies.map((c) => c.companyId);
  await inReplica(admin, async (transaction) => {
    for (const t of [...TABLES].reverse()) await admin.query(`DELETE FROM ${t.table} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await admin.query('DELETE FROM finance.reconciliations WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    for (const t of ['metric_snapshots', 'rm_finance_health', 'rm_finance_sector_margin', 'rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
      await admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const admin = connect();
  seedLoad(admin, { seed: arg('--seed'), scale: arg('--scale'), companies: arg('--companies') ? Number(arg('--companies')) : undefined })
    .then((r) => { console.log(JSON.stringify({ companies: r.companies.length, rows: r.rows, digest: r.digest }, null, 2)); })
    .catch((err) => { console.error(`seedLoad: ${err.message}`); process.exitCode = 1; })
    .finally(() => admin.close());
}

module.exports = { seedLoad, cleanupLoad, digestOf, connect, inReplica };
