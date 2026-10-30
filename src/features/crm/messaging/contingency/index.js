'use strict';

/**
 * Contingência do WhatsApp no CRM (Marco 9, M9-D227): fila com mensagem QUEUED (nunca entregue), canal alternativo com consentimento (outro fornecedor ou e-mail), marketing que aguarda e é
 * cancelado ao vencer, tarefa do responsável pelo atendimento e mensagem vencida na fila que vira modelo. Liga os ganchos do framework de contingência (M9-D226) para a família MESSAGING.
 */
const contingency = require('../../../integrations/contingency');
const { handleAgedMessage } = require('./mc.aged');
const { buildMessageTask } = require('./mc.task');
const { onMessageDispatchMoved } = require('./mc.moved');
const { messagingStep } = require('./mc.step');
const { installWindowGuard } = require('./mc.window');
const { sendViaAlternateChannel } = require('./mc.email');
const { NOT_MARKETING_SQL } = require('./mc.essential');
const { WHATSAPP_CONTINGENCY_SETTINGS_SCHEMA } = require('./mc.settings');

const DOMAIN = 'MESSAGING';
let installed = false;

function installMessagingContingency() {
  if (installed) return;
  installed = true;
  contingency.registerAlternateSqlFilter(DOMAIN, NOT_MARKETING_SQL);
  contingency.registerAgedHandler(DOMAIN, handleAgedMessage);
  contingency.registerManualTaskBuilder(DOMAIN, buildMessageTask);
  contingency.registerDispatchMoved(DOMAIN, onMessageDispatchMoved);
  contingency.registerContingencyStep(DOMAIN, messagingStep);
  installWindowGuard();
}

installMessagingContingency();

module.exports = { installMessagingContingency, sendViaAlternateChannel, WHATSAPP_CONTINGENCY_SETTINGS_SCHEMA };
