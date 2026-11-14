'use strict';

/**
 * DI-DEC007-5: o caso do antifraude fica gravado mesmo quando o pagamento é bloqueado. Na preparação (intenção ou pedido de aprovação) de um
 * lançamento ainda não avaliado, a avaliação retém o lançamento e abre o caso na transação da requisição; se o achado é bloqueante, a resposta é 409 e o
 * rollback da requisição levaria junto a retenção, os casos, a notificação e a auditoria. Por isso a avaliação é refeita numa transação SEPARADA, no
 * contexto da mesma empresa, depois do rollback: o mesmo gancho `transaction.afterRollbackCleanups` que o tenant.middleware executa depois de desfazer a
 * transação (padrão do código, ex.: files.service.js). A reavaliação é idempotente (lançamento já retido ou com caso aberto não é avaliado de novo).
 * Fora de uma requisição HTTP (transação sem o gancho), nada é registrado aqui: quem abriu a transação decide o que fazer com o erro.
 */
const { sequelize, FinancialEntry } = require('../../../../models');
const logger = require('../../../../utils/logger');

async function reevaluateInOwnTransaction({ entryId, groupId, companyId, actorUserId }) {
  try {
    await sequelize.transaction(async (tx) => {
      await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId, companyId }, transaction: tx });
      if (actorUserId) await sequelize.query("SELECT set_config('app.user_id', :userId, true)", { replacements: { userId: actorUserId }, transaction: tx });
      const entry = await FinancialEntry.findByPk(entryId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!entry) return;
      await require('./payment-anomaly-gate').evaluatePayableAnomaly(entry, tx, 'prepare');
    });
  } catch (/** @type {any} */ err) {
    logger.error({ err: err && err.message, entryId }, 'finance.antifraud.after_rollback_failed');
  }
}

/** Agenda a regravação da retenção e dos casos para depois do rollback da transação da requisição. */
function keepFindingsAfterRollback(entry, actorUserId, transaction) {
  if (!transaction || !entry) return;
  const job = { entryId: entry.id, groupId: entry.groupId, companyId: entry.companyId, actorUserId };
  transaction.afterRollbackCleanups = [...(transaction.afterRollbackCleanups || []), () => reevaluateInOwnTransaction(job)];
}

module.exports = { keepFindingsAfterRollback, reevaluateInOwnTransaction };
