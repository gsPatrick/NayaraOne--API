'use strict';

const { texto } = require('../../../registry/webhookSchemas');

/** Esquema do evento `email.received` do sandbox (M9-D235): a mensagem recebida com os anexos em base64 (o provedor real que entrega por endereço entra como adapter novo). */
const INBOUND_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'type', 'message'],
  properties: {
    id: texto(160),
    type: { type: 'string', enum: ['email.received'] },
    api_version: texto(16),
    message: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: texto(160),
        from: { type: 'string', maxLength: 254 },
        to: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 254 } },
        subject: { type: 'string', maxLength: 998 },
        text: { type: 'string', maxLength: 500000 },
        inReplyTo: { type: 'string', maxLength: 998 },
        references: { type: 'string', maxLength: 2000 },
        attachments: {
          type: 'array',
          maxItems: 100,
          items: { type: 'object', additionalProperties: false, required: ['fileName'], properties: { fileName: texto(255), contentType: { type: 'string', maxLength: 160 }, contentBase64: { type: 'string' } } },
        },
      },
    },
    occurredAt: texto(40),
  },
});

module.exports = { INBOUND_SCHEMA };
