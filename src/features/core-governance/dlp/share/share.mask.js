'use strict';

const MASKED = new Set(['HIGH', 'RESTRICTED']);

/**
 * Máscara anônima (M9-D823 §3 item 4): o visitante do link é tratado como uma pessoa sem NENHUMA permissão sensível — todo campo HIGH ou RESTRICTED sai com o texto de
 * máscara; LOW e MEDIUM saem em claro. `fields` mapeia o caminho do campo (ex.: `parties.taxId`, `[]` entra em listas) para a classe; campo sem classe declarada é tratado como
 * HIGH (o mais conservador). Enquanto o registro M9-D910/D915 não existe, as classes vêm do catálogo de recursos compartilháveis.
 */
function maskValue(value, path, fields, maskText) {
  if (Array.isArray(value)) return value.map((item) => maskValue(item, path, fields, maskText));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskValue(inner, path ? `${path}.${key}` : key, fields, maskText)]));
  }
  if (value === null || value === undefined) return value;
  return MASKED.has(fields[path] || 'HIGH') ? maskText : value;
}

const maskForAnonymous = (data, fields, maskText) => maskValue(data, '', fields, maskText);

module.exports = { maskForAnonymous };
