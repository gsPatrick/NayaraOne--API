'use strict';

const { sequelize } = require('../../../models');
const { SEND_ACTION_TYPE } = require('./policy.statuses');

/**
 * Reserva a ação de envio na run (status PENDING, com canal, finalidade e horário) NA MESMA transação e sob a mesma trava do
 * canSend, para a próxima checagem do cap já contar esta ação antes de a mensagem existir (M9-D416). Chamada pelo runner (M9-D414)
 * logo depois de um canSend permitido. Devolve a ação gravada.
 */
async function reserveSendAction({ runId, actionKey, channel, purpose, at = new Date() }, tenant, transaction) {
  const action = { action_key: actionKey, action_type: SEND_ACTION_TYPE, status: 'PENDING', channel, purpose, at: at.toISOString() };
  await sequelize.query(
    `UPDATE marketing.automation_runs SET actions_result = actions_result || CAST(:action AS jsonb), updated_at = CURRENT_TIMESTAMP
      WHERE id = :runId AND company_id = :companyId`,
    { replacements: { action: JSON.stringify([action]), runId, companyId: tenant.companyId }, transaction }
  );
  return action;
}

module.exports = { reserveSendAction };
