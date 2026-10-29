'use strict';

const { sequelize, IntegrationWebhookInbox } = require('../../../models');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');
const { recordError } = require('../errors');
const { readInboxParams } = require('./inbox.params');
const { sha256Hex } = require('./inbox.hash');
const { pickHeaders } = require('./inbox.headers');
const { eventIdMissing, unknownChannel } = require('./inbox.errors');
const { countDuplicate } = require('./inbox.metrics');
const { MISMATCH_CODE } = require('./inbox.constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSERT_SQL = `
INSERT INTO "integration"."webhook_inbox"
  (group_id, company_id, connection_id, provider_code, channel, external_event_id, event_type, api_version, signature_valid,
   payload_hash, payload_raw, payload, headers_json, correlation_id, status, attempts, processed_at, dead_letter_reason)
VALUES (:groupId, :companyId, :connectionId, :providerCode, :channel, :eventId, :eventType, :apiVersion, true,
        :hash, :raw, CAST(:payload AS jsonb), CAST(:headers AS jsonb), :correlationId, :status, :attempts,
        CASE WHEN :status = 'PROCESSED' THEN now() END, :deadReason)
ON CONFLICT (provider_code, external_event_id) DO NOTHING
RETURNING id`;

/** Corpo grande demais não é guardado inteiro: ficam o hash, o tamanho e o resumo (limite configurável). */
function bodyToStore(raw, body, maxBytes) {
  if (raw.length <= maxBytes) return { raw, payload: body === undefined ? null : body };
  return { raw: null, payload: { truncated: true, size: raw.length, sha256: sha256Hex(raw) } };
}

/**
 * receiveEvent — grava um evento JÁ autenticado (assinatura conferida por quem chama). O mesmo
 * (fornecedor, id externo) nunca grava segunda linha: devolve {status:'duplicate'} e conta na métrica. Se o hash do corpo
 * difere do original, é tentativa de adulteração: registra WEBHOOK_PAYLOAD_MISMATCH (HIGH) e mantém o original.
 * `d`: providerCode, externalEventId, rawBody (Buffer|texto), body (já lido), headers, eventType, apiVersion, channel,
 * connectionId, extraHeaders (ex.: {caseRef}), processedInline (quem processa na hora, como o Correspondente, grava já
 * PROCESSED para o worker não repetir o efeito), deadLetterReason (M9-D211: evento assinado mas com conteúdo inválido já nasce DEAD_LETTER, sem corpo guardado).
 */
async function receiveEvent(ctx, d, transaction) {
  if (!ctx || !ctx.companyId || !ctx.groupId) throw unknownChannel();
  const eventId = typeof d.externalEventId === 'string' ? d.externalEventId.trim() : '';
  if (!eventId) throw eventIdMissing();
  const providerCode = String(d.providerCode || '').trim().toLowerCase().slice(0, 48);
  const raw = Buffer.isBuffer(d.rawBody) ? d.rawBody : Buffer.from(d.rawBody != null ? String(d.rawBody) : JSON.stringify(d.body ?? null), 'utf8');
  const hash = sha256Hex(raw);
  const params = await readInboxParams(ctx, transaction);
  const deadReason = d.deadLetterReason ? String(d.deadLetterReason).slice(0, 80) : null;
  const stored = deadReason ? { raw: null, payload: null } : bodyToStore(raw, d.body, params.maxBodyBytes);
  const correlation = getCurrentCorrelationId();
  const headers = { ...pickHeaders(d.headers, params.headerAllowlist), ...(d.extraHeaders || {}) };

  const [rows] = await sequelize.query(INSERT_SQL, {
    replacements: {
      groupId: ctx.groupId, companyId: ctx.companyId, connectionId: d.connectionId || null, providerCode, channel: d.channel ? String(d.channel).slice(0, 48) : null,
      eventId: eventId.slice(0, 160), eventType: d.eventType ? String(d.eventType).slice(0, 80) : null, apiVersion: d.apiVersion ? String(d.apiVersion).slice(0, 16) : null,
      hash, raw: stored.raw, payload: JSON.stringify(stored.payload), headers: JSON.stringify(headers),
      correlationId: correlation && UUID_RE.test(correlation) ? correlation : null,
      status: deadReason ? 'DEAD_LETTER' : (d.processedInline ? 'PROCESSED' : 'RECEIVED'), attempts: d.processedInline ? 1 : 0, deadReason,
    },
    transaction,
  });
  if (rows.length > 0) return { status: 'accepted', id: rows[0].id, payloadHash: hash };

  countDuplicate(providerCode);
  const original = await IntegrationWebhookInbox.findOne({ where: { providerCode, externalEventId: eventId.slice(0, 160) }, attributes: ['id', 'payloadHash'], transaction });
  const mismatch = Boolean(original) && original.payloadHash !== hash;
  if (mismatch) {
    await recordError(ctx, {
      providerCode, source: 'WEBHOOK', errorClass: 'SECURITY', errorCode: MISMATCH_CODE, connectionId: d.connectionId || null, sourceRefId: original.id,
      operation: 'webhook.inbox', message: 'Um evento já recebido chegou de novo com conteúdo diferente: o original foi mantido.',
      payload: { externalEventId: eventId, originalHash: original.payloadHash, receivedHash: hash }, allowlist: ['externalEventId', 'originalHash', 'receivedHash'], payloadHash: hash,
    }, transaction);
  }
  return { status: 'duplicate', id: original ? original.id : null, mismatch, payloadHash: hash };
}

module.exports = { receiveEvent };
