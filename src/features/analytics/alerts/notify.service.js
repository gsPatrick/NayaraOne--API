'use strict';

/**
 * M9-D692 (3.5) — aviso do alerta aberto pelo motor de notificações (Notification, canal IN_APP) a cada destinatário. Conteúdo mínimo: código do
 * alerta, gravidade, métrica e link do painel; NUNCA o valor medido (métrica restrita não vaza número pelo aviso). Só a abertura avisa: repetição
 * e supressão não geram aviso novo (M9-D691).
 */
const { Notification } = require('../../../models');

const TITLE_MAX = 255;
const LABELS = Object.freeze({ INFO: 'Informação', WARNING: 'Atenção', CRITICAL: 'Crítico' });

/** { title, body } do aviso. Só os campos nomeados aqui entram no texto: valores recebidos de fora são ignorados de propósito. */
function buildNotification({ alertCode, severity, metricCode, instanceId, link }) {
  const label = LABELS[severity] || severity;
  return {
    title: `[${label}] Alerta ${alertCode}`.slice(0, TITLE_MAX),
    body: `O alerta ${alertCode} (indicador ${metricCode}) foi aberto com gravidade ${label}. Abra o painel para ver o detalhe e reconhecer: ${link} (alerta ${instanceId}).`,
  };
}

/** Cria um aviso por destinatário na transação do chamador. Devolve quantos criou. */
async function notifyAlertOpened({ def, instance, scope, link, userIds }, transaction) {
  if (!userIds.length) return 0;
  const { title, body } = buildNotification({ alertCode: def.alert_code, severity: instance.severity, metricCode: instance.metric_code || def.metric_code, instanceId: instance.id, link });
  await Notification.bulkCreate(
    userIds.map((userId) => ({ groupId: scope.groupId, companyId: scope.companyId, userId, channel: 'IN_APP', title, body })),
    { transaction }
  );
  return userIds.length;
}

module.exports = { buildNotification, notifyAlertOpened };
