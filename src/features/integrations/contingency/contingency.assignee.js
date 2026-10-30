'use strict';

const { getSetting } = require('../../settings/settings.service');
const { activeUserIdsWithRole } = require('../../core-governance/governance.users');
const { PADROES } = require('./contingency.limits');

/**
 * Responsável de uma tarefa de contingência do domínio (M9-D227 e M9-D228): a primeira pessoa ativa do papel configurado para o domínio (`roleKey`, com `fallbackRole` de padrão);
 * sem ninguém ativo nele, a do papel das tarefas manuais da contingência (`integration.contingency.manual_task_assignee_role`, M9-D226). Devolve o id ou null.
 */
async function resolveDomainAssignee(ctx, roleKey, fallbackRole, transaction) {
  const papel = String((await getSetting(roleKey, ctx, transaction, fallbackRole)) || fallbackRole);
  const donos = (await activeUserIdsWithRole(papel, { companyId: ctx.companyId }, transaction)).sort();
  if (donos.length) return donos[0];
  const geral = String((await getSetting('integration.contingency.manual_task_assignee_role', ctx, transaction, PADROES.manualTaskAssigneeRole)) || PADROES.manualTaskAssigneeRole);
  return ((await activeUserIdsWithRole(geral, { companyId: ctx.companyId }, transaction)).sort())[0] || null;
}

module.exports = { resolveDomainAssignee };
