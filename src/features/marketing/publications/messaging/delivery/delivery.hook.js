'use strict';

const { registerWebhookEventHook } = require('../../adapters');
const { applyDeliveryStatus } = require('./delivery.status');

const CHANNELS = ['WHATSAPP', 'EMAIL'];

/** Liga o webhook de status dos canais (POST /marketing/webhooks/:channel) à mensagem do CRM: só WhatsApp e e-mail, só evento com status e id do recurso. */
async function onChannelEvent({ tenant, channel, event }, transaction) {
  if (!CHANNELS.includes(channel) || !event.status || !event.providerRef) return;
  await applyDeliveryStatus({ tenant, channel, providerRef: event.providerRef, status: event.status }, transaction);
}

let installed = false;
function installDeliveryHook() {
  if (installed) return;
  installed = true;
  registerWebhookEventHook(onChannelEvent);
}

module.exports = { installDeliveryHook, onChannelEvent };
