'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** SQL da campanha (marketing.campaigns). Sempre filtra pela empresa da sessão e ignora linhas excluídas logicamente. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/** Colunas que o serviço pode atualizar na campanha, na ordem do UPDATE. */
const UPDATABLE = Object.freeze({
  name: 'name', objective: 'objective', objectiveMetric: 'objective_metric', targetValue: 'target_value', budgetAmount: 'budget_amount',
  budgetJustification: 'budget_justification', channels: 'channels', startsAt: 'starts_at', endsAt: 'ends_at', ownerUserId: 'owner_user_id',
  status: 'status', resultValue: 'result_value', costActual: 'cost_actual', costUpdatedAt: 'cost_updated_at', costStale: 'cost_stale',
  massConfirmedBy: 'mass_confirmed_by', massConfirmedAt: 'mass_confirmed_at',
});

async function findById(id, tenant, transaction, { lock = false } = {}) {
  const [row] = await run(
    `SELECT * FROM marketing.campaigns WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    { id, companyId: tenant.companyId }, transaction
  );
  return row || null;
}

async function codeExists(code, tenant, transaction) {
  const rows = await run('SELECT 1 FROM marketing.campaigns WHERE company_id = :companyId AND code = :code', { companyId: tenant.companyId, code }, transaction);
  return rows.length > 0;
}

async function insertDraft({ tenant, code, name, objective, ownerUserId, actor }, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.campaigns (id, group_id, company_id, code, name, objective, owner_user_id, status, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :code, :name, :objective, :ownerUserId, 'DRAFT', :actor, :actor) RETURNING *`,
    { groupId: tenant.groupId, companyId: tenant.companyId, code, name, objective, ownerUserId, actor: actor || null }, transaction
  );
  return row;
}

/** UPDATE parcial: só as chaves de UPDATABLE presentes em `patch`. Devolve a linha atualizada. */
async function update(id, patch, actor, transaction) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE[k] !== undefined && patch[k] !== undefined);
  // text[] não aceita lista em replacement nomeado: vai como JSON e o banco monta o array.
  const expr = (k) => (k === 'channels' ? "(SELECT coalesce(array_agg(x), '{}'::text[]) FROM jsonb_array_elements_text(CAST(:channels AS jsonb)) x)" : `:${k}`);
  const sets = keys.map((k) => `${UPDATABLE[k]} = ${expr(k)}`);
  const [row] = await run(
    `UPDATE marketing.campaigns SET ${[...sets, 'updated_by = :actor', 'updated_at = now()'].join(', ')} WHERE id = :id RETURNING *`,
    { ...Object.fromEntries(keys.map((k) => [k, k === 'channels' ? JSON.stringify(patch[k]) : patch[k]])), actor: actor || null, id }, transaction
  );
  return row;
}

/** Campanhas vencidas para a transição automática (sem travar; cada uma é travada e relida em seguida). */
const dueToStart = (tenant, now, transaction) => run(
  `SELECT id FROM marketing.campaigns WHERE company_id = :companyId AND status = 'SCHEDULED' AND starts_at <= :now AND deleted_at IS NULL ORDER BY starts_at, id`,
  { companyId: tenant.companyId, now }, transaction
);
const dueToEnd = (tenant, now, transaction) => run(
  `SELECT id FROM marketing.campaigns WHERE company_id = :companyId AND status = 'RUNNING' AND ends_at <= :now AND deleted_at IS NULL ORDER BY ends_at, id`,
  { companyId: tenant.companyId, now }, transaction
);

/** O responsável precisa ter vínculo ativo com a empresa (core.user_memberships). */
async function ownerBelongsToCompany(userId, tenant, transaction) {
  const rows = await run(
    `SELECT 1 FROM core.user_memberships WHERE user_id = :userId AND company_id = :companyId AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`,
    { userId, companyId: tenant.companyId }, transaction
  );
  return rows.length > 0;
}

module.exports = { run, findById, codeExists, insertDraft, update, dueToStart, dueToEnd, ownerBelongsToCompany };
