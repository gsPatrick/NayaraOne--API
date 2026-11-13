'use strict';

/** Assinatura digital do Jurídico sobre o framework de integrações (Marco 9, M9-D236). Fachada da API do módulo. */
const { installSignatureEvents, applySignatureEvent } = require('./signature.events');
const { installEnvelopeBinder } = require('./signature.bind');
const { requestEnvelope } = require('./signature.request');
const { ensureSignatureConnection, PROVIDER_CODES } = require('./signature.connection');
const { resolveSignatureWebhookSecret } = require('./signature.secrets');
const { tryCompleteContract, evidenceGate } = require('./signature.complete');
const { callEnvelope, downloadSigned } = require('./signature.adapter');
const { SIGNATURE_SETTINGS_SCHEMA } = require('./signature.settings');
const { applyClicksignEvent } = require('./signature.legacy');

const { switchSignatureProvider, onEnvelopeDispatchMoved } = require('./signature.switch');
const { queryEnvelopeStatus } = require('./signature.status');
const { buildManualEvidence } = require('./signature.manual');

installSignatureEvents();
require('../../../../features/integrations/contingency/contingency.domainHooks').registerDispatchMoved('SIGNATURE', onEnvelopeDispatchMoved); // M9-D227: o envelope acompanha o envio que troca de fornecedor
installEnvelopeBinder();

module.exports = {
  switchSignatureProvider, queryEnvelopeStatus, buildManualEvidence,
  requestEnvelope, ensureSignatureConnection, PROVIDER_CODES, resolveSignatureWebhookSecret, tryCompleteContract, evidenceGate, callEnvelope, downloadSigned, applySignatureEvent, SIGNATURE_SETTINGS_SCHEMA, applyClicksignEvent,
};
