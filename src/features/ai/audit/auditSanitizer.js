'use strict';

const { getSetting } = require('../../settings/settings.service');
const { redactForAi, redactDeepForAi, isSensitiveKey } = require('../../../shared/redaction');
const { SUMMARY_MAX_KEY, AUDIT_SETTING_DEFAULTS } = require('./audit.settings');

/**
 * Chaves que carregam conteúdo bruto e nunca são guardadas nem logadas: prompt completo, documento inteiro, resposta bruta do
 * provider, vetores de embedding, mensagens da conversa e cabeçalhos HTTP (M9-D028: "nunca é guardado").
 */
const FORBIDDEN_KEYS = new Set([
  'prompt', 'fullprompt', 'rawprompt', 'systemprompt', 'messages', 'document', 'documenttext', 'fulldocument', 'rawresponse',
  'providerresponse', 'embedding', 'embeddings', 'vector', 'vectors', 'headers',
]);
const normalize = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
const isForbiddenKey = (key) => FORBIDDEN_KEYS.has(normalize(key));

/** Remove, em qualquer profundidade, as chaves de conteúdo bruto; a redação de segredo e dado pessoal fica na biblioteca de M9-D246. */
function dropForbidden(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => dropForbidden(v, depth + 1));
  // Error: preserva nome, mensagem e pilha (a redação os trata depois) e filtra as propriedades próprias.
  const out = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : {};
  for (const [key, inner] of Object.entries(value)) if (!isForbiddenKey(key)) out[key] = dropForbidden(inner, depth + 1);
  return out;
}

/** Limite do resumo: parâmetro da empresa (ia.auditoria.resumo_max_caracteres); padrão 2000. */
async function summaryLimit(ctx, transaction) {
  const n = Number(await getSetting(SUMMARY_MAX_KEY, ctx, transaction, AUDIT_SETTING_DEFAULTS[SUMMARY_MAX_KEY]));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, AUDIT_SETTING_DEFAULTS[SUMMARY_MAX_KEY]) : AUDIT_SETTING_DEFAULTS[SUMMARY_MAX_KEY];
}

/** Resumo redigido pelo perfil `ai` (`[REDIGIDO:tipo]`, M9-D027: sem segredo nem dado pessoal) e cortado em `limit` caracteres; null continua null. */
function sanitizeSummary(text, limit) {
  if (text === null || text === undefined) return text;
  return redactForAi(String(text)).slice(0, limit);
}

/** JSON de chamadas de ferramenta: sem conteúdo bruto e redigido pela biblioteca única. */
function sanitizeToolCalls(value) {
  if (value === null || value === undefined) return value;
  return redactDeepForAi(dropForbidden(value));
}

module.exports = { sanitizeSummary, sanitizeToolCalls, summaryLimit, dropForbidden, isForbiddenKey, isSensitiveKey };
