'use strict';

const { materialAlteration, videoInvalid } = require('./video.errors');

/**
 * M9-D426 regra 3 — registro de operações da montagem (allowlist). Só entram corte, ordenação, legenda e trilha licenciada; nenhuma operação age sobre os pixels do
 * imóvel. Qualquer outra (as proibidas do livro e as desconhecidas) é recusada com MKT_MEDIA_MATERIAL_ALTERATION: um plugin que introduza operação generativa não
 * passa, porque o que não está na allowlist não existe para a montagem.
 */
const ALLOWED_OPERATIONS = Object.freeze(['CUT', 'ORDER', 'CAPTION', 'LICENSED_TRACK']);
/** As alterações que o livro nomeia como proibidas (só para o motivo da recusa ser claro; a regra é a allowlist). */
const KNOWN_FORBIDDEN = Object.freeze(['REMOVE_ELEMENT', 'ADD_ELEMENT', 'SKY_REPLACE', 'COLOR_CHANGE', 'FACADE_RECOLOR', 'FINISH_RECOLOR', 'ENHANCE_STATE', 'GENERATIVE_FILL', 'RETOUCH', 'OBJECT_REMOVAL']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

const NORMALIZERS = {
  CUT: (o) => {
    const startS = num(o.startS); const endS = num(o.endS);
    if (!text(o.mediaId, 40) || startS === null || endS === null || startS < 0 || endS <= startS) throw videoInvalid('Corte inválido: informe mediaId, startS e endS (endS maior que startS).', { operation: 'CUT' });
    return { op: 'CUT', mediaId: o.mediaId.trim(), startS, endS };
  },
  ORDER: (o) => {
    if (!Array.isArray(o.order) || o.order.length === 0 || !o.order.every((id) => text(id, 40))) throw videoInvalid('Ordenação inválida: informe a lista de mediaId.', { operation: 'ORDER' });
    return { op: 'ORDER', order: o.order.map((id) => id.trim()) };
  },
  CAPTION: (o) => {
    const caption = text(o.text, 300);
    if (!caption) throw videoInvalid('Legenda inválida: informe o texto (até 300 caracteres).', { operation: 'CAPTION' });
    return { op: 'CAPTION', text: caption, ...(num(o.atS) !== null ? { atS: num(o.atS) } : {}) };
  },
  LICENSED_TRACK: (o) => {
    if (!text(o.trackRef, 120) || !text(o.licenseRef, 120)) throw videoInvalid('Trilha inválida: informe trackRef e a licença (licenseRef).', { operation: 'LICENSED_TRACK' });
    return { op: 'LICENSED_TRACK', trackRef: o.trackRef.trim(), licenseRef: o.licenseRef.trim() };
  },
};

/** Normaliza e confere a lista de operações; a primeira fora da allowlist para tudo (nada é aplicado pela metade). */
function validateOperations(operations) {
  if (operations === undefined || operations === null) return [];
  if (!Array.isArray(operations) || operations.length > 200) throw videoInvalid('Dados inválidos: operacoes.', { field: 'operacoes' });
  return operations.map((raw) => {
    const name = isObject(raw) && typeof raw.op === 'string' ? raw.op.trim().toUpperCase() : null;
    if (!name) throw videoInvalid('Operação inválida.', { field: 'operacoes' });
    if (!ALLOWED_OPERATIONS.includes(name)) {
      throw materialAlteration({ operation: name, reason: KNOWN_FORBIDDEN.includes(name) ? 'FORBIDDEN_OPERATION' : 'NOT_ALLOWLISTED', allowed: ALLOWED_OPERATIONS });
    }
    return NORMALIZERS[name](raw);
  });
}

module.exports = { ALLOWED_OPERATIONS, KNOWN_FORBIDDEN, validateOperations };
