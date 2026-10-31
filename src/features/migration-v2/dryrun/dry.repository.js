'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = `id, kind, status, conclusion, requested_by AS "requestedBy", commit_hash AS "commit", phases, volumes, criteria, blockers, errors, quarantine, samples,
  run_ids AS "runIds", started_at AS "startedAt", finished_at AS "finishedAt"`;
const JSON_FIELDS = { phases: 'phases', volumes: 'volumes', criteria: 'criteria', blockers: 'blockers', errors: 'errors', quarantine: 'quarantine', samples: 'samples', runIds: 'run_ids' };

/** Abre o relatório RUNNING; o índice único parcial deixa só um ensaio em andamento por empresa (violação vira null). */
async function open(tenant, { userId, commit }, transaction) {
  const rows = await select(
    `INSERT INTO governance.mig_dry_reports (group_id, company_id, requested_by, commit_hash) VALUES (:groupId, :companyId, :userId, :commit)
     ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, userId: userId || null, commit: commit || null }, transaction
  );
  return rows[0] || null;
}

async function get(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_dry_reports WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

const running = async (tenant, transaction) => (await select(`SELECT ${COLUMNS} FROM governance.mig_dry_reports WHERE company_id = :companyId AND status = 'RUNNING'`, { companyId: tenant.companyId }, transaction))[0] || null;

/** Grava o progresso (campos JSON do relatório) sem mexer no estado. */
async function save(tenant, id, parts, transaction) {
  const sets = Object.keys(parts).filter((key) => JSON_FIELDS[key]).map((key) => `${JSON_FIELDS[key]} = CAST(:${key} AS jsonb)`);
  if (!sets.length) return;
  const replacements = { companyId: tenant.companyId, id };
  for (const key of Object.keys(parts)) if (JSON_FIELDS[key]) replacements[key] = JSON.stringify(parts[key]);
  await sequelize.query(`UPDATE governance.mig_dry_reports SET ${sets.join(', ')} WHERE company_id = :companyId AND id = :id AND status = 'RUNNING'`, { transaction, replacements });
}

/** Encerra o relatório: COMPLETED com a conclusão, ou ABORTED (sem conclusão). */
async function finish(tenant, id, { status, conclusion, parts }, transaction) {
  await save(tenant, id, parts || {}, transaction);
  await sequelize.query(
    "UPDATE governance.mig_dry_reports SET status = :status, conclusion = :conclusion, finished_at = now() WHERE company_id = :companyId AND id = :id AND status = 'RUNNING'",
    { transaction, replacements: { companyId: tenant.companyId, id, status, conclusion: conclusion || null } }
  );
}

module.exports = { open, get, running, save, finish };
