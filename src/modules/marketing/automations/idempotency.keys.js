'use strict';

const crypto = require('node:crypto');
const { mktError } = require('../marketing.errors');

/**
 * M9-D415 — fórmulas das chaves de idempotência (Guia §5): run = sha256(versão:evento:sujeito); ação = sha256(chaveDaRun:índice:tipo).
 * Tudo em hexadecimal minúsculo. `trigger_config.dedupeKey` (template com campos do payload) substitui o id do evento.
 */
const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

function required(name, value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw mktError(422, 'MKT_RUN_KEY_INVALID', `Não foi possível calcular a chave da execução: o campo "${name}" é obrigatório.`, { field: name });
  return text;
}

/** subjectId pode faltar só em gatilho de agenda (sem sujeito); nesse caso entra vazio na fórmula. */
function runIdempotencyKey({ automationVersionId, triggerEventId, subjectId }) {
  return sha256Hex(`${required('automationVersionId', automationVersionId)}:${required('triggerEventId', triggerEventId)}:${subjectId == null ? '' : subjectId}`);
}

function actionKey(runKey, index, actionType) {
  return sha256Hex(`${required('runKey', runKey)}:${Number(index)}:${required('actionType', actionType)}`);
}

function readPath(payload, path) {
  return path.split('.').reduce((acc, part) => (acc !== null && typeof acc === 'object' ? acc[part] : undefined), payload);
}

/** Valor que ocupa o lugar de `triggerEventId` na chave da run: o dedupeKey resolvido, ou o id do evento. */
function resolveTriggerEventId({ triggerConfig, payload, eventId }) {
  const template = triggerConfig && typeof triggerConfig.dedupeKey === 'string' ? triggerConfig.dedupeKey.trim() : '';
  if (!template) return required('eventId', eventId);
  const resolved = template.replace(/\{([^{}]+)\}/g, (_, path) => {
    const value = readPath(payload || {}, path.trim());
    if (value === undefined || value === null || typeof value === 'object' || String(value).trim() === '') {
      throw mktError(422, 'MKT_DEDUPE_KEY_INVALID', `A chave de deduplicação do gatilho usa o campo "${path.trim()}", que não veio no evento.`, { field: path.trim() });
    }
    return String(value).trim();
  });
  return resolved;
}

module.exports = { sha256Hex, runIdempotencyKey, actionKey, resolveTriggerEventId };
