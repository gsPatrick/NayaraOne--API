'use strict';

const { isSensitiveKey } = require('./keys');
const { redactText, REDACTED } = require('./text');

const MAX_DEPTH = 12;

/**
 * redactDeep(valor, opções) — devolve uma CÓPIA do valor sem segredo, em qualquer profundidade (M9-D246 3.1).
 *  - chave sensível (por nome)        → `[REDACTED]`;
 *  - texto                            → redactText (padrões de valor);
 *  - objeto com toJSON (SecretValue)  → o que o toJSON devolve, também redigido;
 *  - Error                            → { name, message, stack } redigidos;
 *  - Buffer                           → descrição de tamanho (nunca o conteúdo).
 */
function redactDeep(value, options = {}, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, options);
  if (typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH || seen.has(value)) return '[Circular]';
  if (value instanceof Error) {
    seen.add(value);
    const out = { name: value.name, message: redactText(value.message, options), stack: redactText(value.stack, options) };
    for (const key of Object.keys(value)) if (!(key in out)) out[key] = isSensitiveKey(key) ? REDACTED : redactDeep(value[key], options, seen, depth + 1);
    seen.delete(value);
    return out;
  }
  if (typeof value.toJSON === 'function') {
    const plain = value.toJSON();
    return plain === value ? REDACTED : redactDeep(plain, options, seen, depth + 1);
  }
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => redactDeep(item, options, seen, depth + 1));
  } else {
    out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) && inner !== null && inner !== undefined ? REDACTED : redactDeep(inner, options, seen, depth + 1);
    }
  }
  seen.delete(value);
  return out;
}

module.exports = { redactDeep };
