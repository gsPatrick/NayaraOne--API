'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, name, source_system, starts_at, ends_at, entities, interval_min, status, created_by, closed_at, created_at';
const RULE_COLUMNS = 'entity, field, rule, tolerance::text AS tolerance, enum_map, options';

async function insertWindow(tenant, window, userId, transaction) {
  const [row] = await select(
    `INSERT INTO governance.parallel_windows (group_id, company_id, name, source_system, starts_at, ends_at, entities, interval_min, created_by)
     VALUES (:groupId, :companyId, :name, :sourceSystem, :startsAt, :endsAt, CAST(:entities AS jsonb), :intervalMin, :userId) RETURNING ${COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, name: window.name, sourceSystem: window.sourceSystem, startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(),
      entities: JSON.stringify(window.entities), intervalMin: window.intervalMin, userId: userId || null,
    }, transaction
  );
  return row;
}

async function insertRules(tenant, windowId, rules, transaction) {
  for (const rule of rules) {
     
    await sequelize.query(
      `INSERT INTO governance.parallel_rules (group_id, company_id, window_id, entity, field, rule, tolerance, enum_map, options)
       VALUES (:groupId, :companyId, :windowId, :entity, :field, :rule, :tolerance, CAST(:enumMap AS jsonb), CAST(:options AS jsonb))`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, windowId, entity: rule.entity, field: rule.field, rule: rule.rule, tolerance: rule.tolerance, enumMap: rule.enumMap ? JSON.stringify(rule.enumMap) : null, options: JSON.stringify(rule.options || {}) } }
    );
  }
}

async function get(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.parallel_windows WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/** Trava a janela até o fim da transação: duas instâncias do job nunca decidem sobre a mesma janela ao mesmo tempo. */
async function lock(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.parallel_windows WHERE company_id = :companyId AND id = :id FOR UPDATE`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

const listRules = (tenant, windowId, transaction) => select(
  `SELECT ${RULE_COLUMNS} FROM governance.parallel_rules WHERE company_id = :companyId AND window_id = :windowId ORDER BY entity, field`, { companyId: tenant.companyId, windowId }, transaction
);

/** Janelas que o job precisa olhar (a SCHEDULED que ainda não começou e a RUNNING, mesmo depois do fim). */
const listActive = (tenant, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.parallel_windows WHERE company_id = :companyId AND status IN ('SCHEDULED', 'RUNNING') ORDER BY starts_at, id`, { companyId: tenant.companyId }, transaction
);

const listRunning = (tenant, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.parallel_windows WHERE company_id = :companyId AND status = 'RUNNING' ORDER BY starts_at, id`, { companyId: tenant.companyId }, transaction
);

function setStatus(tenant, id, status, transaction) {
  return select(
    `UPDATE governance.parallel_windows SET status = :status, closed_at = CASE WHEN :status = 'CLOSED' THEN now() ELSE closed_at END, updated_at = now()
      WHERE company_id = :companyId AND id = :id RETURNING ${COLUMNS}`, { companyId: tenant.companyId, id, status }, transaction
  ).then((rows) => rows[0] || null);
}

module.exports = { insertWindow, insertRules, get, lock, listRules, listActive, listRunning, setStatus };
