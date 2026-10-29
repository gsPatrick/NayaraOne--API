'use strict';

const Ajv = require('ajv');
const { pickSchema } = require('../../registry/webhookSchemaPick');
const { PermanentWebhookFailure } = require('./worker.errors');

const ajv = new Ajv({ allErrors: false, unknownFormats: 'ignore' });
const compilados = new WeakMap();

const validadorDe = (schema) => {
  if (!compilados.has(schema)) compilados.set(schema, ajv.compile(schema));
  return compilados.get(schema);
};

/** Corpo do evento: o JSON já lido; se só o bruto foi guardado, lê dele; corpo grande demais para ser guardado não pode ser conferido. */
function readPayload(row) {
  if (row.payload && typeof row.payload === 'object' && row.payload.truncated === true) {
    throw new PermanentWebhookFailure('SCHEMA_INVALID', 'O corpo do evento é grande demais para ser guardado e conferido.');
  }
  if (row.payload && typeof row.payload === 'object') return row.payload;
  if (row.payloadRaw) {
    try { return JSON.parse(Buffer.from(row.payloadRaw).toString('utf8')); } catch { /* cai no erro abaixo */ }
  }
  throw new PermanentWebhookFailure('SCHEMA_INVALID', 'O corpo do evento não está disponível para conferência.');
}

/**
 * Versão e esquema do evento (M9-D212 3.2 item 2, M9-D213 3.3): a versão da API precisa estar em `supportedVersions()` do adapter (VERSION_UNSUPPORTED) e o payload
 * precisa passar no JSON Schema que o adapter declara para o tipo e a versão (SCHEMA_INVALID, inclusive quando o adapter não declara esquema). Lança a falha permanente.
 */
function validateEvent(adapter, row, payload) {
  if (!adapter) throw new PermanentWebhookFailure('SCHEMA_INVALID', 'Não há adaptador registrado para o fornecedor do evento.', { payload });
  const suportadas = adapter.supportedVersions();
  const apiVersion = row.apiVersion || adapter.webhookApiVersion(payload, row.headersJson || {}) || suportadas[0];
  if (!suportadas.includes(apiVersion)) {
    throw new PermanentWebhookFailure('VERSION_UNSUPPORTED', `A versão ${String(apiVersion).slice(0, 16)} da API do fornecedor não é suportada.`, { payload });
  }
  const schema = pickSchema(adapter, row.eventType, apiVersion);
  if (!schema) throw new PermanentWebhookFailure('SCHEMA_INVALID', 'O fornecedor não declara esquema para este tipo de evento e versão.', { payload });
  const valida = validadorDe(schema);
  if (!valida(payload)) {
    const e = (valida.errors || [])[0] || {};
    throw new PermanentWebhookFailure('SCHEMA_INVALID', `O evento não cumpre o esquema: ${e.dataPath || '(raiz)'} ${e.message || ''}`.trim().slice(0, 300), { payload, schema });
  }
  return { apiVersion, schema };
}

module.exports = { validateEvent, readPayload };
