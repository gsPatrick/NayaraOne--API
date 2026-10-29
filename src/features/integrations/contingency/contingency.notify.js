'use strict';

const logger = require('../../../utils/logger');
const { Notification } = require('../../../models');
const { activeUserIdsWithRole } = require('../../core-governance/governance.users');

const TITLE_MAX = 255;

/** Usuários ativos dos papéis (sem repetir quem tem mais de um). */
async function recipients(ctx, roles, transaction) {
  const ids = new Set();
  for (const role of roles) (await activeUserIdsWithRole(role, { companyId: ctx.companyId }, transaction)).forEach((id) => ids.add(id));
  return [...ids];
}

const LABEL = (v) => v.providerCode || (v.domain ? `família ${v.domain}` : 'integração');

/**
 * Avisa os papéis de `notify_roles` (notificação da plataforma, canal IN_APP) que a contingência foi ativada ou encerrada. Sem destinatário
 * o fato continua no painel e no log. Devolve quantas notificações foram criadas.
 */
async function notifyContingency(ctx, kind, view, roles, transaction) {
  const users = await recipients(ctx, roles, transaction);
  if (!users.length) {
    logger.warn({ roles, connectionId: view.connectionId, domain: view.domain }, 'Contingência de integração sem destinatário: ninguém ativo nos papéis configurados.');
    return 0;
  }
  const ativa = kind === 'ACTIVATED';
  const titulo = ativa ? `[CONTINGÊNCIA] ${LABEL(view)} fora do ar: plano B ativado` : `Contingência encerrada: ${LABEL(view)} voltou ao normal`;
  const corpo = ativa
    ? `Modo ${view.mode}. Motivo: ${view.reasons.join(', ') || 'não informado'}. A fila segue e o que passar do prazo vira tarefa manual. Acompanhe em Integrações > Saúde.`
    : 'A integração se recuperou: a fila foi liberada em ordem de criação e o canal alternativo voltou a ser reserva.';
  await Notification.bulkCreate(
    users.map((userId) => ({ groupId: ctx.groupId, companyId: ctx.companyId, userId, channel: 'IN_APP', title: titulo.slice(0, TITLE_MAX), body: corpo })),
    { transaction },
  );
  return users.length;
}

module.exports = { notifyContingency };
