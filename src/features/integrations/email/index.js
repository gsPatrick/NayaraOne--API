'use strict';

/**
 * E-mail de saída pelo adapter (Marco 9, M9-D234): mensagem do domínio ligada ao envio do Dispatch Service, estados por evidência do provedor e anexos autorizados e
 * classificados. Ao carregar, liga o observador do envio (identificador da mensagem), o passo da rodada do worker (envio recusado de vez) e o tratador dos eventos do
 * provedor. Fachada da API pública.
 */
const { sendEmail } = require('./email.send');
const { installEmailBinder } = require('./email.bind');
const { installEmailEvents, applyEmailEvent } = require('./email.events');
const { validateAttachments } = require('./email.attachments');
const { normalizeRecipients } = require('./email.recipients');
const { readEmailParams, PADROES } = require('./email.params');
const { syncFailedMessages } = require('./email.sync');
const { EMAIL_SETTINGS_SCHEMA } = require('./email.settings');
const { STATUSES } = require('./email.constants');

installEmailBinder();
installEmailEvents();

module.exports = {
  sendEmail, validateAttachments, normalizeRecipients, readEmailParams, EMAIL_PADROES: PADROES, syncFailedMessages, applyEmailEvent, EMAIL_SETTINGS_SCHEMA, EMAIL_STATUSES: STATUSES,
};
