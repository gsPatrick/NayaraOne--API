'use strict';

/**
 * E-mail recebido pelo pipeline de malware e dado pessoal (Marco 9, M9-D235). Ao carregar, liga o passo da rodada do worker que decide os anexos verificados pela quarentena.
 * Fachada da API pública; o e-mail nunca é a fonte única de documento: o que vale é o arquivo promovido ao módulo `files`.
 */
const { registerDispatchCycleStep } = require('../../dispatch/worker/worker.hooks');
const { ingestInboundEmail } = require('./inbound.ingest');
const { applyInboundEvent } = require('./inbound.event');
const { settlePendingAttachments, settleAttachment } = require('./inbound.attachments');
const { listInboundMessages, getInboundMessage, linkInboundMessage } = require('./inbound.read');
const { registerInboundReferenceResolver } = require('./inbound.link');
const { pollInboundEmail } = require('./inbound.poll');
const { pollAllInboundEmail } = require('./inbound.pollAll');
const { analyzePii } = require('./inbound.pii');
const { readInboundParams, PADROES } = require('./inbound.params');
const { INBOUND_SETTINGS_SCHEMA } = require('./inbound.settings');

let installed = false;
function installInbound() {
  if (installed) return;
  installed = true;
  registerDispatchCycleStep((ctx, _meta, transaction) => settlePendingAttachments(ctx, transaction));
}
installInbound();

module.exports = {
  ingestInboundEmail, applyInboundEvent, settlePendingAttachments, settleAttachment, listInboundMessages, getInboundMessage, linkInboundMessage, registerInboundReferenceResolver, pollInboundEmail, pollAllInboundEmail, analyzePii,
  readInboundParams, INBOUND_PADROES: PADROES, INBOUND_SETTINGS_SCHEMA,
};
