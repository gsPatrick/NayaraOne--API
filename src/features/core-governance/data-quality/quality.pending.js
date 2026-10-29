'use strict';

const logger = require('../../../utils/logger');
const { sequelize } = require('../../../models');
const { isModuleEnabled } = require('../governance.module');

/**
 * Avaliação "na gravação do cadastro" (M9-D806 §3.3). Os hooks dos modelos (quality.hooks.js) só ANOTAM na transação o cadastro tocado; as avaliações
 * rodam uma vez por cadastro, no fim da transação da requisição e antes do commit (tenant.middleware chama flushQualityEvaluations). Assim uma
 * gravação que cria o cadastro e depois seus contatos e endereço não abre issues de estados intermediários. A avaliação roda num savepoint: se
 * falhar, o cadastro é gravado do mesmo jeito (a varredura noturna recupera) e o erro vai para o log.
 */
const KEY = 'qualityPending';

function markForQuality(transaction, tenant, entityType, entityId, actorUserId) {
  if (!transaction || !entityId || !tenant.companyId) return;
  if (!transaction[KEY]) transaction[KEY] = new Map();
  transaction[KEY].set(`${entityType}:${entityId}`, { tenant: { groupId: tenant.groupId, companyId: tenant.companyId }, entityType, entityId, actorUserId: actorUserId || null });
}

async function flushQualityEvaluations(transaction) {
  const pending = transaction && transaction[KEY];
  if (!pending || !pending.size) return 0;
  transaction[KEY] = new Map();
  const { evaluateEntity } = require('./quality.evaluate');
  const enabled = new Map();
  let done = 0;
  for (const item of pending.values()) {
    try {
      if (!enabled.has(item.tenant.companyId)) enabled.set(item.tenant.companyId, await isModuleEnabled('data-quality', item.tenant, transaction));
      if (!enabled.get(item.tenant.companyId)) continue;
      await sequelize.transaction({ transaction }, (savepoint) => evaluateEntity(item.tenant, item.entityType, item.entityId, savepoint, { actorUserId: item.actorUserId }));
      done += 1;
    } catch (err) {
      logger.error({ err: err.message, entityType: item.entityType, entityId: item.entityId }, 'dataQuality.evaluateOnSave.failed');
    }
  }
  return done;
}

module.exports = { markForQuality, flushQualityEvaluations };
