'use strict';

const { Notification } = require('../../../../models');
const { CHANNEL_IN_APP } = require('../../calendar/alerts/alerts.constants');
const { usersWithPermission } = require('../../dlp/anomaly.notify');
const { APPROVE } = require('./payment.constants');

/** Chave do alerta de um dia: no máximo um por operação e por dia (M9-D833 §3.3). */
const alertKey = (manualReference, day) => `bcp.payment_unreconciled:${manualReference}:${day}`;

/** Alerta CRÍTICO IN_APP a todos com `governance:bcp:approve` e a quem importou. Devolve quantos avisos criou. */
async function notifyUnreconciled(tenant, pending, today, transaction) {
  const users = new Set(await usersWithPermission(tenant, APPROVE, transaction));
  users.add(pending.importedBy);
  const reais = (pending.amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const title = `[CRÍTICA] Pagamento manual sem conciliação: ${pending.manualReference}`;
  const body = `O pagamento emergencial ${pending.manualReference} (${reais}) deveria estar casado com o extrato bancário até ${pending.deadlineOn} e ainda não está. Confira o extrato e concilie. Alerta de ${today}.`;
  for (const userId of users) {
    await Notification.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: CHANNEL_IN_APP, title, body, createdBy: null, updatedBy: null }, { transaction });
  }
  return users.size;
}

module.exports = { alertKey, notifyUnreconciled };
