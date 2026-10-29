'use strict';

const { sequelize, Company, Notification } = require('../../../models');
const { dateKeyInZone } = require('../calendar/sources/time');
const { claimAlert } = require('../calendar/alerts/alerts.log');
const { CHANNEL_IN_APP, ALERT_TYPE } = require('../calendar/alerts/alerts.constants');
const { activeAdminIds } = require('../governance.users');
const repository = require('./stewardship.repository');
const { listDomains } = require('./stewardship.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

async function notifyAdmins(tenant, title, body, transaction) {
  const admins = await activeAdminIds(tenant, transaction);
  for (const userId of admins) {
    await Notification.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: CHANNEL_IN_APP, title, body, createdBy: null, updatedBy: null }, { transaction });
  }
  return admins.length;
}

/**
 * Usuário desativado (ou sem vínculo) na empresa: fecha as designações vigentes dele (nunca apaga) e avisa o administrador
 * (M9-D804 §3.2 regra 2). Devolve quantas designações foram fechadas.
 */
async function closeAssignmentsOfUser(tenant, userId, reason, transaction) {
  const closed = await repository.closeUserAssignments(tenant, userId, reason, transaction);
  if (!closed.length) return 0;
  const names = [...new Set(closed.map((row) => `${row.role}`))].join(', ');
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'governance.data_domain.assignments_closed', entityType: 'governance.data_domain',
    entityId: closed[0].domain_id, beforeJson: closed, afterJson: null, reason: `Designações de dados encerradas: ${reason}.`,
  }, transaction);
  await notifyAdmins(tenant, 'Responsável de dados desativado', `${closed.length} designação(ões) de dados (${names}) foram encerradas porque a pessoa responsável deixou de estar ativa. Designe outra pessoa em Dados mestres.`, transaction);
  return closed.length;
}

/** Usuário desativado no sistema: aplica o fechamento em cada empresa do grupo (cada uma na sua transação de tenant). */
async function closeAssignmentsOfUserInGroup(groupId, userId, reason) {
  const companies = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true)', { replacements: { groupId }, transaction });
    return Company.findAll({ transaction });
  });
  let total = 0;
  for (const company of companies) {
    total += await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId, companyId: company.id }, transaction });
      return closeAssignmentsOfUser({ groupId, companyId: company.id }, userId, reason, transaction);
    });
  }
  return total;
}

/**
 * Avaliação noturna (chamada pelo job de qualidade de M9-D806): um aviso IN_APP ao administrador por domínio pendente e por dia
 * (`dq.domain_pending:<domínio>:<AAAA-MM-DD>`), com a pendência mais grave do domínio.
 */
async function notifyPendingDomains(tenant, transaction, now = new Date()) {
  const day = dateKeyInZone(now);
  const summary = { pending: 0, notified: 0 };
  for (const domain of await listDomains(tenant, transaction)) {
    if (!domain.pendencies.length) continue;
    summary.pending += 1;
    const admins = await activeAdminIds(tenant, transaction);
    if (!admins.length) continue;
    const claimed = await claimAlert(tenant, { key: `dq.domain_pending:${domain.code}:${day}`, type: ALERT_TYPE.DQ_DOMAIN_PENDING, itemId: null, recipients: admins.length }, transaction);
    if (!claimed) continue;
    await notifyAdmins(tenant, 'Domínio de dados com pendência', `${domain.code}: ${domain.pendencies.map((p) => p.message).join(' e ')}.`, transaction);
    summary.notified += 1;
  }
  return summary;
}

module.exports = { closeAssignmentsOfUser, closeAssignmentsOfUserInGroup, notifyPendingDomains };
