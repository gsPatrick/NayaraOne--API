'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const flag = require('./canary.flag');
const gate = require('./canary.gate');
const members = require('./canary.members');
const errors = require('./canary.errors');
const { isSector } = require('./canary.constants');

const names = async (ids, transaction) => (ids.length
  ? sequelize.query('SELECT id, name FROM core.users WHERE id IN (:ids)', { type: QueryTypes.SELECT, transaction, replacements: { ids } })
  : []);

/**
 * Provedor de impacto da linha 15 do inventário (migration.canary.rollback, M9-D852): os usuários do setor que hoje operam no sistema novo e voltam ao antigo, e os blockers
 * abertos do setor na Torre (informativos). Setor já em 0% é impedimento. O código a digitar é o do setor.
 */
async function canaryRollbackProvider({ id, tenant, transaction, itemsMax }) {
  if (!isSector(id)) throw errors.sectorUnknown(id);
  const entry = await flag.readEntry(tenant, id, transaction);
  const percent = flag.percentOf(entry);
  const { selected, members: all } = await members.canaryOf(tenant, id, percent, transaction);
  const { blockers } = await gate.sectorBlockers(tenant, id, transaction);
  const label = new Map((await names(selected.slice(0, itemsMax || 50), transaction)).map((row) => [row.id, row.name]));
  return {
    code: id,
    label: `Setor ${id}`,
    impact: {
      counts: { percent, usersTotal: all.length, usersInCanary: selected.length, blockers: blockers.length },
      totalAmountCents: 0,
      blockers: percent === 0 ? [{ code: 'GOV_CANARY_ALREADY_AT_ZERO', message: 'Este setor já está no sistema antigo.' }] : [],
      items: selected.slice(0, itemsMax || 50).map((userId) => ({ type: 'USER', id: userId, label: label.get(userId) || userId })),
    },
  };
}

module.exports = { canaryRollbackProvider };
