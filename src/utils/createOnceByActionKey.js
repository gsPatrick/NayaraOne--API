'use strict';

const { sequelize } = require('../models');

/**
 * M9-D415 — cria o registro de destino de uma ação de automação uma única vez por `action_key`.
 *
 * O INSERT roda dentro de um SAVEPOINT; se o UNIQUE (company_id, action_key) disparar (replay ou corrida de duas conexões, em que a
 * segunda espera a primeira confirmar), desfaz só o savepoint e devolve o registro que já existe, com `replay: true`. A transação do
 * chamador segue utilizável. Qualquer outro erro sobe sem alteração.
 */
function isActionKeyConflict(error) {
  const parent = error && error.parent;
  return Boolean(parent && parent.code === '23505' && /action_key/.test(`${parent.constraint || ''} ${parent.detail || ''}`));
}

async function createOnceByActionKey(Model, values, { transaction } = {}) {
  if (!values.actionKey) return { record: await Model.create(values, { transaction }), replay: false };
  try {
    const record = await sequelize.transaction({ transaction }, (savepoint) => Model.create(values, { transaction: savepoint }));
    return { record, replay: false };
  } catch (error) {
    if (!isActionKeyConflict(error)) throw error;
    const record = await Model.findOne({ where: { companyId: values.companyId, actionKey: values.actionKey }, transaction });
    if (!record) throw error;
    return { record, replay: true };
  }
}

module.exports = { createOnceByActionKey, isActionKeyConflict };
