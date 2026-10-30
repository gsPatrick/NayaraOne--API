'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const targets = require('./retention.targets');

/**
 * Elegibilidade de um alvo sob uma política (M9-D911 §3.3.1): `eligible_at = data do gatilho + retention_months` (mês de calendário; dia 31 vira o último dia do mês de
 * destino, a mesma regra do Postgres) e elegível quando `eligible_at <= hoje`. Registro com exceção ativa vem marcado (`has_exception`); só exceção que a política
 * lista E que o alvo sabe avaliar conta. O que já foi concluído (DONE) com a mesma disposição não volta (anonimizado ou arquivado uma vez). SQL só do catálogo fixo.
 */
function selectSql(target, policy, { restrictIds = false } = {}) {
  const trigger = target.triggers[policy.trigger];
  if (!trigger) throw new Error(`O alvo ${target.code} não aceita o gatilho ${policy.trigger}.`);
  const active = policy.exceptions.map((name) => target.exceptions[name]).filter(Boolean);
  const exception = active.length ? `(${active.map((sql) => `(${sql})`).join(' OR ')})` : 'FALSE';
  return `SELECT t.id::text AS record_id, trig.d AS trigger_date, (trig.d + make_interval(months => :months))::date AS eligible_at, ${exception} AS has_exception
    FROM ${target.schema}.${target.table} t
    CROSS JOIN LATERAL (SELECT (${trigger}) AS d) trig
    WHERE t.company_id = :companyId AND (${target.baseWhere}) AND trig.d IS NOT NULL
      AND (trig.d + make_interval(months => :months))::date <= CAST(:today AS date)
      ${restrictIds ? 'AND t.id IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb))::uuid)' : ''}
      AND NOT EXISTS (SELECT 1 FROM governance.retention_run_items done WHERE done.company_id = :companyId AND done.target_code = :targetCode
                       AND done.record_id = t.id::text AND done.state = 'DONE' AND done.disposition = :disposition)`;
}

const base = (tenant, policy, targetCode, today) => ({ companyId: tenant.companyId, months: policy.retentionMonths, today, targetCode, disposition: policy.disposition });
const run = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Contagens do alvo: elegíveis e os que têm exceção ativa. */
async function counts(tenant, policy, target, today, transaction) {
  const [row] = await run(`SELECT count(*)::int AS eligible, count(*) FILTER (WHERE has_exception)::int AS blocked_exception FROM (${selectSql(target, policy)}) e`, base(tenant, policy, target.code, today), transaction);
  return { eligible: row.eligible, blockedByException: row.blocked_exception };
}

/** Grava de uma vez (set-based) o conjunto da simulação: elegíveis sem exceção, em ordem de chave, já numerados em lotes. Devolve quantos entraram. */
async function insertCandidates(tenant, policy, target, today, { runId, batchSize }, transaction) {
  const inserted = await run(
    `INSERT INTO governance.retention_run_items (group_id, company_id, run_id, policy_code, policy_version, target_code, record_id, disposition, batch_no)
     SELECT :groupId, :companyId, :runId, :policyCode, :version, :targetCode, e.record_id, :disposition, ((row_number() OVER (ORDER BY e.record_id) - 1) / :batchSize)::int
       FROM (${selectSql(target, policy)}) e WHERE NOT e.has_exception RETURNING id`,
    { ...base(tenant, policy, target.code, today), groupId: tenant.groupId, runId, policyCode: policy.code, version: policy.version, batchSize }, transaction
  );
  return inserted.length;
}

/** Uma página (por chave crescente) dos candidatos sem exceção. */
async function candidatesPage(tenant, policy, target, today, { after, limit }, transaction) {
  const rows = await run(`SELECT record_id FROM (${selectSql(target, policy)}) e WHERE NOT has_exception AND record_id > :after ORDER BY record_id LIMIT :limit`,
    { ...base(tenant, policy, target.code, today), after, limit }, transaction);
  return rows.map((row) => row.record_id);
}

/** Dos `ids`, os que continuam elegíveis hoje (com a marca de exceção). */
async function recheck(tenant, policy, target, today, ids, transaction) {
  return run(`SELECT record_id, has_exception FROM (${selectSql(target, policy, { restrictIds: true })}) e`, { ...base(tenant, policy, target.code, today), ids: JSON.stringify(ids) }, transaction);
}

/** Amostra de chaves elegíveis sem exceção. */
const sample = (tenant, policy, target, today, limit, transaction) => candidatesPage(tenant, policy, target, today, { after: '', limit }, transaction);

module.exports = { selectSql, counts, insertCandidates, candidatesPage, recheck, sample, targetOf: (code) => targets.get(code) };
