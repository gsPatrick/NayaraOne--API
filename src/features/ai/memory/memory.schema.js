'use strict';

const E = require('./memory.errors');

/**
 * Schema do `value` por tipo (M9-D009): só fatos estruturados, nenhum campo livre fora da lista. kind: text (texto curto, limite
 * `ia.memoria.valor_max_caracteres`), uuid, date (AAAA-MM-DD), list (lista de textos curtos, 1 a 20), enum.
 */
const OUTCOMES = Object.freeze(['ACCEPTED', 'REJECTED', 'EXECUTED', 'EXECUTION_FAILED']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_MAX = 20;

const SCHEMAS = Object.freeze({
  DECISION: { decision: { kind: 'text', required: true }, rationale: { kind: 'text' }, decided_on: { kind: 'date' } },
  COMPANY_PREFERENCE: { preference: { kind: 'text', required: true }, details: { kind: 'text' }, applies_to: { kind: 'text' } },
  APPROVED_PROCEDURE: { title: { kind: 'text', required: true }, steps: { kind: 'list', required: true }, reference: { kind: 'text' } },
  RECOMMENDATION_OUTCOME: { recommendation_id: { kind: 'uuid', required: true }, outcome: { kind: 'enum', values: OUTCOMES, required: true }, result: { kind: 'text' } },
});

const requiredFields = (type) => new Set(Object.entries(SCHEMAS[type]).filter(([, s]) => s.required).map(([n]) => n));

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function checkField(name, spec, v) {
  const bad = (msg) => E.valueInvalid(`Campo "${name}" inválido: ${msg}.`, { campo: name });
  if (spec.kind === 'text' && !isText(v)) throw bad('informe um texto');
  if (spec.kind === 'uuid' && !(typeof v === 'string' && UUID_RE.test(v))) throw bad('informe um identificador válido');
  if (spec.kind === 'date' && !(typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)))) throw bad('use AAAA-MM-DD');
  if (spec.kind === 'enum' && !spec.values.includes(v)) throw bad(`use um de ${spec.values.join(', ')}`);
  if (spec.kind === 'list' && !(Array.isArray(v) && v.length >= 1 && v.length <= LIST_MAX && v.every(isText))) throw bad(`lista de 1 a ${LIST_MAX} textos`);
}

/** Confere o `value` (já sem dado pessoal e sem texto longo) contra o schema do tipo. `transcript` só passa quando liberado. */
function validateValue(type, value, { allowTranscript = false } = {}) {
  const schema = SCHEMAS[type];
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    if (name === 'transcript' && allowTranscript) { out[name] = v; continue; }
    if (!schema[name]) throw E.valueInvalid(`O campo "${name}" não existe no tipo ${type}.`, { campo: name, permitidos: Object.keys(schema) });
    checkField(name, schema[name], v);
    out[name] = v;
  }
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.required && out[name] === undefined) throw E.valueInvalid(`Falta o campo obrigatório "${name}".`, { campo: name });
  }
  return out;
}

module.exports = { SCHEMAS, OUTCOMES, requiredFields, validateValue };
