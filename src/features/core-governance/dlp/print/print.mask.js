'use strict';

/**
 * Máscara da impressão (M9-D920 §3.1: "campos mascarados continuam mascarados"): quem passou pelo guard viu o recurso, então LOW, MEDIUM e HIGH saem em claro; RESTRICTED só
 * em claro para quem tem a permissão dedicada (`governance:dlp:view-restricted`); sem ela, o campo sai com o texto de máscara. `fields` mapeia o caminho do campo para a classe;
 * campo sem classe declarada vale HIGH (o mais conservador entre os que ainda saem).
 */
function maskValue(value, path, fields, clear, maskText) {
  if (Array.isArray(value)) return value.map((item) => maskValue(item, path, fields, clear, maskText));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskValue(inner, path ? `${path}.${key}` : key, fields, clear, maskText)]));
  }
  if (value === null || value === undefined) return value;
  return clear.has(fields[path] || 'HIGH') ? value : maskText;
}

const maskForPrint = (data, fields, { canViewRestricted, maskText }) => maskValue(data, '', fields, new Set(['LOW', 'MEDIUM', 'HIGH', ...(canViewRestricted ? ['RESTRICTED'] : [])]), maskText);

module.exports = { maskForPrint };
