'use strict';

const { mktError } = require('../../marketing.errors');
const { CHANNELS } = require('./channels');

/** Erros do ChannelAdapter (M9-D430 4): código MKT_ e mensagem em português, nunca detalhe do provedor. */
const channelNotReleased = (details) => mktError(409, 'MKT_CHANNEL_NOT_RELEASED', 'Este canal ainda não foi liberado para produção.', details);
const webhookSignatureInvalid = () => mktError(401, 'MKT_WEBHOOK_SIGNATURE_INVALID', 'Assinatura do webhook inválida.');
const webhookPayloadInvalid = (details) => mktError(422, 'MKT_WEBHOOK_PAYLOAD_INVALID', 'Corpo do webhook inválido.', details);
const releasePrereqMissing = (missing, channel) => mktError(422, 'MKT_CHANNEL_RELEASE_PREREQ_MISSING', 'Faltam pré-requisitos para liberar o canal.', { channel, missing });
const operationUnsupported = (channel, operation) => mktError(422, 'MKT_CHANNEL_OPERATION_UNSUPPORTED', 'Este canal não suporta a operação pedida.', { channel, operation });
const releaseServiceOnly = (key) => mktError(403, 'MKT_CHANNEL_RELEASE_SERVICE_ONLY', 'Este parâmetro só é alterado pela liberação do canal.', { key });
const channelNotFound = () => mktError(404, 'MKT_CHANNEL_NOT_FOUND', 'Canal não encontrado.');
const invalid = (message, details) => mktError(422, 'MKT_VALIDATION', message, details);

/** Canal conhecido em maiúsculas; qualquer outro valor é 422. */
function normalizeChannel(value) {
  const channel = String(value || '').trim().toUpperCase();
  if (!CHANNELS.includes(channel)) throw invalid('Canal desconhecido.', { campo: 'channel', validos: CHANNELS });
  return channel;
}

module.exports = {
  channelNotReleased, webhookSignatureInvalid, webhookPayloadInvalid, releasePrereqMissing, operationUnsupported, releaseServiceOnly, channelNotFound, invalid, normalizeChannel,
};
