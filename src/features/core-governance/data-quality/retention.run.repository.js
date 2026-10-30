'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { ITEM_STATE } = require('./retention.constants');

const q = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = `id, mode, source, status, reference_date, batch_size, policy_codes, report, apply_summary, error_message, created_by, applied_by, applied_at, created_at, updated_at`;

function present(row) {
  return {
    id: row.id, mode: row.mode, source: row.source, status: row.status, referenceDate: row.reference_date, batchSize: row.batch_size, policyCodes: row.policy_codes, report: row.report,
    applySummary: row.apply_summary, errorMessage: row.error_message, createdBy: row.created_by, appliedBy: row.applied_by, appliedAt: row.applied_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function createRun(tenant, { source, referenceDate, batchSize, policyCodes }, actorUserId, transaction) {
  const rows = await q(
    `INSERT INTO governance.retention_runs (group_id, company_id, source, reference_date, batch_size, policy_codes, created_by)
     VALUES (:groupId, :companyId, :source, CAST(:referenceDate AS date), :batchSize, CAST(:policyCodes AS jsonb), :actorUserId) RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, source, referenceDate, batchSize, policyCodes: JSON.stringify(policyCodes), actorUserId: actorUserId || null }, transaction
  );
  return present(rows[0]);
}

async function saveReport(runId, report, transaction) {
  await q('UPDATE governance.retention_runs SET report = CAST(:report AS jsonb), updated_at = now() WHERE id = :runId RETURNING id', { runId, report: JSON.stringify(report) }, transaction);
}

async function getRun(tenant, runId, transaction, { forUpdate = false } = {}) {
  const rows = await q(`SELECT ${COLUMNS} FROM governance.retention_runs WHERE id = :runId AND company_id = :companyId ${forUpdate ? 'FOR UPDATE' : ''}`, { runId, companyId: tenant.companyId }, transaction);
  return rows[0] ? present(rows[0]) : null;
}

async function listRuns(tenant, { limit, offset }, transaction) {
  const [{ total }] = await q('SELECT count(*)::int AS total FROM governance.retention_runs WHERE company_id = :companyId', { companyId: tenant.companyId }, transaction);
  const rows = await q(`SELECT ${COLUMNS} FROM governance.retention_runs WHERE company_id = :companyId ORDER BY created_at DESC, id LIMIT :limit OFFSET :offset`, { companyId: tenant.companyId, limit, offset }, transaction);
  return { rows: rows.map(present), total };
}

/** status APPLYING/APPLIED/FAILED; `mode` vira APPLY quando o apply começa. */
async function setStatus(runId, status, fields, transaction) {
  await q(
    `UPDATE governance.retention_runs SET status = :status, mode = CASE WHEN :status = 'DRY_DONE' THEN mode ELSE 'APPLY' END, error_message = :error,
       apply_summary = COALESCE(CAST(:summary AS jsonb), apply_summary), applied_by = COALESCE(:appliedBy, applied_by),
       applied_at = CASE WHEN :status = 'APPLIED' THEN now() ELSE applied_at END, updated_at = now() WHERE id = :runId RETURNING id`,
    { runId, status, error: fields.error || null, summary: fields.summary ? JSON.stringify(fields.summary) : null, appliedBy: fields.appliedBy || null }, transaction
  );
}

const heartbeat = (runId, transaction) => q('UPDATE governance.retention_runs SET updated_at = now() WHERE id = :runId RETURNING id', { runId }, transaction);

/** Insere os itens do conjunto da simulação (só a chave); o número do lote vem da posição, de `offset` em diante. */
async function insertItems(tenant, runId, policy, target, ids, offset, batchSize, transaction) {
  if (!ids.length) return;
  await q(
    `INSERT INTO governance.retention_run_items (group_id, company_id, run_id, policy_code, policy_version, target_code, record_id, disposition, batch_no)
     SELECT :groupId, :companyId, :runId, :policyCode, :version, :targetCode, r.elem, :disposition, ((:offset + r.ord - 1) / :batchSize)::int
       FROM jsonb_array_elements_text(CAST(:ids AS jsonb)) WITH ORDINALITY AS r(elem, ord) RETURNING id`,
    { groupId: tenant.groupId, companyId: tenant.companyId, runId, policyCode: policy.code, version: policy.version, targetCode: target.code, disposition: policy.disposition, offset, batchSize, ids: JSON.stringify(ids) }, transaction
  );
}

/** Tira do conjunto da simulação as chaves que estão sob legal hold (ficam só na contagem blocked_by_hold). */
async function deleteItems(runId, targetCode, recordIds, transaction) {
  if (!recordIds.length) return;
  await q('DELETE FROM governance.retention_run_items WHERE run_id = :runId AND target_code = :targetCode AND record_id IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb))) RETURNING id',
    { runId, targetCode, ids: JSON.stringify(recordIds) }, transaction);
}

/** Próximo lote pendente (alvo e número), em ordem. */
async function nextBatch(runId, transaction) {
  const rows = await q("SELECT target_code, batch_no FROM governance.retention_run_items WHERE run_id = :runId AND state = 'PENDING' ORDER BY target_code, batch_no LIMIT 1", { runId }, transaction);
  return rows[0] ? { targetCode: rows[0].target_code, batchNo: rows[0].batch_no } : null;
}

async function batchItems(runId, { targetCode, batchNo }, transaction) {
  const rows = await q("SELECT id, policy_code, policy_version, record_id, disposition FROM governance.retention_run_items WHERE run_id = :runId AND target_code = :targetCode AND batch_no = :batchNo AND state = 'PENDING' ORDER BY record_id FOR UPDATE",
    { runId, targetCode, batchNo }, transaction);
  return rows.map((r) => ({ id: r.id, policyCode: r.policy_code, policyVersion: r.policy_version, recordId: r.record_id, disposition: r.disposition }));
}

/** Marca os itens (por id) com o estado e o motivo. */
async function markItems(ids, state, reason, detail, transaction) {
  if (!ids.length) return;
  await q('UPDATE governance.retention_run_items SET state = :state, reason = :reason, detail = CAST(:detail AS jsonb), processed_at = now() WHERE id IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb))::uuid) RETURNING id',
    { ids: JSON.stringify(ids), state, reason: reason || null, detail: detail ? JSON.stringify(detail) : null }, transaction);
}

/** Contagem dos itens por alvo e estado. */
async function stateCounts(runId, transaction) {
  const rows = await q('SELECT target_code, state, count(*)::int AS n FROM governance.retention_run_items WHERE run_id = :runId GROUP BY 1, 2 ORDER BY 1, 2', { runId }, transaction);
  const byTarget = {};
  for (const r of rows) { byTarget[r.target_code] = byTarget[r.target_code] || {}; byTarget[r.target_code][r.state] = r.n; }
  return byTarget;
}

/** Página das chaves PENDING de um alvo (para reconferir holds), por chave crescente. */
async function pendingIds(runId, targetCode, { after, limit }, transaction) {
  const rows = await q("SELECT record_id FROM governance.retention_run_items WHERE run_id = :runId AND target_code = :targetCode AND state = 'PENDING' AND record_id > :after ORDER BY record_id LIMIT :limit", { runId, targetCode, after, limit }, transaction);
  return rows.map((r) => r.record_id);
}

async function listItems(runId, { state, limit, offset }, transaction) {
  const where = state ? 'AND state = :state' : '';
  const [{ total }] = await q(`SELECT count(*)::int AS total FROM governance.retention_run_items WHERE run_id = :runId ${where}`, { runId, state }, transaction);
  const rows = await q(`SELECT target_code, record_id, disposition, batch_no, state, reason FROM governance.retention_run_items WHERE run_id = :runId ${where} ORDER BY target_code, record_id LIMIT :limit OFFSET :offset`, { runId, state, limit, offset }, transaction);
  return { rows, total };
}

/** Soma monetária (em centavos) do alvo entre os itens PENDING; o banco multiplica por 100 (sem ponto flutuante). */
async function pendingAmountCents(runId, target, transaction) {
  if (!target.amountSql) return 0;
  const rows = await q(`SELECT COALESCE(ROUND(SUM(${target.amountSql}) * 100), 0)::bigint AS cents FROM governance.retention_run_items i JOIN ${target.schema}.${target.table} t ON t.id::text = i.record_id
    WHERE i.run_id = :runId AND i.target_code = :targetCode AND i.state = 'PENDING'`, { runId, targetCode: target.code }, transaction);
  return Number(rows[0].cents);
}

module.exports = { createRun, saveReport, getRun, listRuns, setStatus, heartbeat, insertItems, deleteItems, nextBatch, batchItems, markItems, stateCounts, pendingIds, listItems, pendingAmountCents, ITEM_STATE };
