'use strict';

const logger = require('../../../../utils/logger');
const { Notification } = require('../../../../models');
const { activeUserIdsWithRole } = require('../../../core-governance/governance.users');
const { ALERT_LABELS } = require('./alerts.constants');

const TITLE_MAX = 255;
const SEVERITY_LABEL = Object.freeze({ LOW: 'BAIXA', MEDIUM: 'MÉDIA', HIGH: 'ALTA', CRITICAL: 'CRÍTICA' });

/** Texto dos detalhes de cada alerta, só números e códigos. */
function detailText(type, d) {
  switch (type) {
    case 'PROVIDER_DOWN': return d.reason === 'CIRCUIT_OPEN' ? 'O disjuntor da integração está aberto há mais tempo que o limite.' : `${d.consecutiveFailures} testes de saúde seguidos falharam.`;
    case 'ERROR_RATE_UP': return `Sucesso de ${d.successRate}% na última hora, abaixo da meta de ${d.target}%.`;
    case 'AUTH_FAILURE': return 'A credencial foi recusada e a integração está pausada até ser corrigida.';
    case 'SECRET_EXPIRING': return `A credencial vence em ${d.daysLeft} dia(s) (aviso de ${d.alertDays} dias).`;
    case 'SYNC_STALLED': return `O fluxo ${d.stream} está sem sincronizar${d.minutesWithoutSuccess === null ? '' : ` há ${d.minutesWithoutSuccess} min (limite ${d.limitMinutes} min)`}.`;
    case 'QUOTA_LOW': return `Restam ${d.remaining} de ${d.limit} da cota do fornecedor.`;
    default: return '';
  }
}

/** Usuários ativos dos papéis configurados (sem repetir quem tem mais de um). */
async function recipients(ctx, roles, transaction) {
  const ids = new Set();
  for (const role of roles) (await activeUserIdsWithRole(role, { companyId: ctx.companyId }, transaction)).forEach((id) => ids.add(id));
  return [...ids];
}

/**
 * Avisa os papéis configurados (motor de notificações da plataforma, canal IN_APP) com o alerta, a gravidade e o link do runbook.
 * `kind`: 'OPEN' (aviso novo), 'REPEAT' (repetição depois de repeat_min) ou 'RECOVERED' (a condição sumiu). Sem destinatário o alerta
 * continua existindo no painel e o fato vai para o log. Devolve quantas notificações foram criadas.
 */
async function notifyAlert(ctx, alert, kind, roles, transaction) {
  const users = await recipients(ctx, roles, transaction);
  if (!users.length) {
    logger.warn({ alertType: alert.alert_type, connectionId: alert.connection_id, roles }, 'Alerta de integração sem destinatário: ninguém ativo nos papéis configurados.');
    return 0;
  }
  const label = ALERT_LABELS[alert.alert_type];
  const titulo = kind === 'RECOVERED'
    ? `${label}: a integração ${alert.provider_code} se recuperou`
    : `[${SEVERITY_LABEL[alert.severity]}] ${label}: ${alert.provider_code}${kind === 'REPEAT' ? ' (continua)' : ''}`;
  const corpo = kind === 'RECOVERED'
    ? `A condição "${label}" deixou de existir e o alerta foi encerrado. Confira em Integrações > Saúde.`
    : `${detailText(alert.alert_type, alert.details || {})} Runbook: ${alert.runbook_path}. Acompanhe em Integrações > Saúde.`;
  await Notification.bulkCreate(
    users.map((userId) => ({ groupId: alert.group_id, companyId: alert.company_id, userId, channel: 'IN_APP', title: titulo.slice(0, TITLE_MAX), body: corpo })),
    { transaction },
  );
  return users.length;
}

module.exports = { notifyAlert, detailText };
