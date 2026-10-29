'use strict';

const crypto = require('node:crypto');
const { SOURCES, rx, redactText } = require('../../../shared/redaction');

/**
 * sanitizeForError — função única que decide o que pode ser guardado em integration_errors (M9-D207, regra 4).
 * Generaliza correspondent/sanitizeProviderMessage.js. Nunca devolve payload bruto, cabeçalho de autorização,
 * segredo nem dado pessoal (CPF, CNPJ, e-mail, telefone, token).
 *
 *  - texto  → texto limpo, limitado a `maxLength` (padrão 500);
 *  - objeto → { sanitized, hash, size }: só campos da `allowlist` (se informada), strings até 200 caracteres,
 *             números e booleanos mantidos, valores sensíveis trocados por "[REDACTED]".
 */
const REDACTED = '[REDACTED]';
const PAYLOAD_STRING_MAX = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const MAX_ITEMS = 20;

const SECRET_KEY_RE = /(password|passwd|senha|secret|token|authorization|auth|card|cartao|cvv|api[-_]?key|cookie|credential|private[-_]?key|signature)/i;
const PII_KEY_RE = /(^|[-_])(cpf|cnpj|rg|e[-_]?mail|phone|telefone|celular|fone|whatsapp)($|[-_])/i;

const PII_TEXT_RULES = [
  [/https?:\/\/\S+/gi, '[endereço removido]'],
  [/\b(bearer|basic|token|apikey|api-key|secret|password|senha)\b\s*[:=]?\s*\S+/gi, '$1 [removido]'],
  [/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '[ip removido]'],
  [rx('email'), '[e-mail removido]'],
  [new RegExp(`\\b${SOURCES.cnpjLoose}\\b`, 'g'), '[CNPJ removido]'],
  [new RegExp(`\\b${SOURCES.cpfLoose}\\b`, 'g'), '[CPF removido]'],
  [new RegExp(`(?<![\\w])${SOURCES.phoneLoose}(?![\\w])`, 'g'), '[telefone removido]'],
  [/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[removido]'],
];

function sanitizeText(value, maxLength = 500) {
  // O texto é cortado ANTES das expressões regulares (M9-D213): evento com um texto de megabytes não pode prender o processador; o resultado já seria cortado em maxLength.
  let text = redactText(String(value ?? '').slice(0, maxLength * 4 + 1000).trim(), { secretsOnly: true });
  for (const [re, troca] of PII_TEXT_RULES) text = text.replace(re, troca);
  return text.slice(0, maxLength);
}

function sanitizeValue(key, value, depth, allowlist) {
  if (SECRET_KEY_RE.test(key) || PII_KEY_RE.test(key)) return REDACTED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeText(value, PAYLOAD_STRING_MAX);
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeValue('', item, depth + 1, null));
  if (typeof value === 'object') return sanitizeObject(value, depth + 1, allowlist);
  return null;
}

function sanitizeObject(obj, depth, allowlist) {
  const out = {};
  const keys = Object.keys(obj).filter((k) => !allowlist || allowlist.includes(k)).slice(0, MAX_KEYS);
  for (const key of keys) out[key.slice(0, 64)] = sanitizeValue(key, obj[key], depth, null);
  return out;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizePayload(payload, { allowlist = null } = {}) {
  const isObject = payload && typeof payload === 'object';
  const sanitized = Array.isArray(payload)
    ? payload.slice(0, MAX_ITEMS).map((item) => sanitizeValue('', item, 1, null))
    : sanitizeObject(isObject ? payload : { value: payload }, 0, Array.isArray(allowlist) ? allowlist : null);
  const json = stableStringify(sanitized);
  return { sanitized, hash: crypto.createHash('sha256').update(json).digest('hex'), size: Buffer.byteLength(json) };
}

function sanitizeForError(input, options = {}) {
  if (input === null || input === undefined) return typeof input === 'string' ? '' : null;
  if (typeof input === 'object') return sanitizePayload(input, options);
  return sanitizeText(input, options.maxLength || 500);
}

module.exports = { sanitizeForError, sanitizeText, sanitizePayload, REDACTED, PAYLOAD_STRING_MAX };
