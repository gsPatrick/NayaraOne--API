'use strict';

const { recordUsage, consolidateClosedHours } = require('../accrual.service');
const { readFinopsParams } = require('../finops.params');
const { PLATFORM_DOMAIN } = require('../finops.constants');

/** Canal de cobrança de cada operação de envio dos ports de mensageria (WhatsApp) e e-mail; SMS entra pela operação sendSms. */
const CHANNEL_BY_OPERATION = Object.freeze({ sendText: 'whatsapp', sendTemplate: 'whatsapp', sendMedia: 'whatsapp', sendEmail: 'email', sendSms: 'sms' });

/**
 * Coletor de mensageria (M9-D860 §3.2): cada envio confirmado de WhatsApp, e-mail ou SMS soma unidades e o custo unitário configurado
 * (`governanca.finops.precos`, centavos por mensagem). Canal sem preço configurado NÃO grava (nunca inventa).
 */
async function recordMessages(tenant, { channel, quantity = 1, domain = PLATFORM_DOMAIN, at = new Date() }, transaction) {
  const params = await readFinopsParams(tenant, transaction);
  const price = params.prices[channel];
  if (price === undefined || !Number.isInteger(quantity) || quantity < 1) return { recorded: false, reason: 'PRICE_UNKNOWN' };
  await recordUsage(tenant, { category: 'MESSAGING', service: channel, domain, quantity, unit: 'messages', costScaled: price * BigInt(quantity), calls: quantity, at }, transaction);
  return { recorded: true };
}

const collectMessaging = (tenant, now, transaction) => consolidateClosedHours(tenant, now, ['MESSAGING'], transaction);

module.exports = { CHANNEL_BY_OPERATION, recordMessages, collectMessaging };
