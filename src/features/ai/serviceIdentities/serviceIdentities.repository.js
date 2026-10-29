'use strict';

const { AiServiceIdentity } = require('../../../models');

/** Acesso a ai.service_identities pelo modelo. Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */
const own = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId });

const list = (scope, transaction) => AiServiceIdentity.findAll({ where: own(scope), order: [['agentCode', 'ASC']], transaction });
const findById = (scope, id, transaction, { lock = false } = {}) => AiServiceIdentity.findOne({ where: { id, ...own(scope) }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
/** A recusa do banco (unicidade, CHECK) acontece num SAVEPOINT: não aborta a transação do chamador. */
const savepoint = (transaction, fn) => AiServiceIdentity.sequelize.transaction({ transaction }, fn);
const insert = (scope, values, transaction) => savepoint(transaction, (sp) => AiServiceIdentity.create({ ...own(scope), ...values }, { transaction: sp }));
const save = (model, transaction) => savepoint(transaction, (sp) => model.save({ transaction: sp }));

/** Identidade ATIVA do agente na empresa (para jobs); null se não houver ou estiver desligada. */
async function findEnabled(scope, agentCode, transaction) {
  const row = await AiServiceIdentity.findOne({ where: { ...own(scope), agentCode, enabled: true }, transaction });
  return row ? row.get({ plain: true }) : null;
}

module.exports = { list, findById, insert, save, findEnabled };
