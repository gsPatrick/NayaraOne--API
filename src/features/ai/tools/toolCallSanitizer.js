'use strict';

/**
 * Sanitização das chamadas de ferramenta (M9-D006): hash canônico (chaves ordenadas), argumentos sem PII nem segredo
 * (redaction do perfil `ai`, M9-D027) e campos `sensitive: true` do input_schema nunca gravados (só o hash do conjunto),
 * resumo curto do resultado. Nenhuma detecção própria: a redaction é a da biblioteca única.
 */
const crypto = require('node:crypto');
const { sanitizeToolCalls } = require('../audit/auditSanitizer');
const { SENSITIVE_MARK } = require('./toolCalls.constants');

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);

/** JSON canônico: chaves ordenadas em qualquer profundidade; undefined some; Date vira ISO; bigint vira texto. */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? JSON.stringify(String(value)) : JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hashOf = (value) => sha256(canonicalJson(value));

/** Troca por marcador o valor de todo campo que o input_schema marca como `sensitive: true` (em objetos e listas aninhados). */
function maskSensitive(value, schema) {
  if (!schema || typeof schema !== 'object' || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, schema.items));
  const props = isPlain(schema.properties) ? schema.properties : {};
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const prop = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
    out[key] = prop && prop.sensitive === true && inner !== undefined ? SENSITIVE_MARK : maskSensitive(inner, prop);
  }
  return out;
}

/** args_sanitized: objeto sem PII nem segredo; valor que não é objeto vira { value }. */
function sanitizeArgs(args, inputSchema) {
  const clean = sanitizeToolCalls(maskSensitive(args === undefined ? {} : args, inputSchema));
  return isPlain(clean) ? clean : { value: clean };
}

/** result_summary: curto, sem documento completo. Acima de `maxChars` guarda só { truncated, chars, preview }. */
function summarizeResult(output, maxChars) {
  const clean = sanitizeToolCalls(output === undefined ? null : output);
  const text = JSON.stringify(clean === undefined ? null : clean);
  if (text.length <= maxChars) return isPlain(clean) ? clean : { value: clean === undefined ? null : clean };
  return { truncated: true, chars: text.length, preview: text.slice(0, maxChars) };
}

module.exports = { canonicalJson, hashOf, sha256, maskSensitive, sanitizeArgs, summarizeResult };
