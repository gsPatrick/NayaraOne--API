'use strict';

/** Falha PERMANENTE do evento (M9-D212 3.2 item 2): o conteúdo nunca vai ser entendido, então não há nova tentativa; vai direto à fila morta. */
class PermanentWebhookFailure extends Error {
  constructor(reason, detail, { payload = null, schema = null } = {}) {
    super(detail);
    this.name = 'PermanentWebhookFailure';
    this.reason = reason;
    this.detail = detail;
    this.payload = payload;
    this.schema = schema;
  }
}

const CODES = Object.freeze({
  SCHEMA_INVALID: 'INTEGRATION_WEBHOOK_SCHEMA_INVALID',
  VERSION_UNSUPPORTED: 'INTEGRATION_WEBHOOK_VERSION_UNSUPPORTED',
  STATUS_UNMAPPED: 'INTEGRATION_WEBHOOK_STATUS_UNMAPPED',
});

const MENSAGENS = Object.freeze({
  SCHEMA_INVALID: 'Evento fora do formato esperado; enviado para a fila de erros.',
  VERSION_UNSUPPORTED: 'Versão da API do fornecedor não suportada; evento enviado para a fila de erros.',
  STATUS_UNMAPPED: 'Status do fornecedor não reconhecido; evento enviado para a fila de erros.',
});

module.exports = { PermanentWebhookFailure, CODES, MENSAGENS };
