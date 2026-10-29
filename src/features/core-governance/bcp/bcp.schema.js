'use strict';

const { TITLES, LABELS } = require('./bcp.forms.labels');

/** Tamanho máximo dos campos de texto do papel (o mesmo limite do validador desde a M9-D831). */
const TEXT_MAX = 2000;
const REF_MAX = 100;

/** Fragmento de JSON Schema (draft-07) de cada tipo de campo; `x-bcpType` guarda o tipo do livro para as mensagens e as regras que o JSON Schema puro não expressa. */
const FRAGMENTS = {
  TEXT: () => ({ type: 'string', minLength: 1, maxLength: TEXT_MAX }),
  REF: () => ({ type: 'string', minLength: 1, maxLength: REF_MAX }),
  INTEGER: () => ({ type: 'integer', minimum: 0 }),
  CENTS: () => ({ type: 'integer', minimum: 1 }),
  DATE: () => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  DATETIME: () => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}' }),
  PERSON_DOC: () => ({ type: 'string', pattern: '^\\D*(\\d\\D*){11}$|^\\D*(\\d\\D*){14}$' }),
  PHONE: () => ({ type: 'string', pattern: '^\\D*(\\d\\D*){10,13}$' }),
  ENUM: (options) => ({ type: 'string', enum: options }),
};

const MAX_LENGTH = { TEXT: TEXT_MAX, REF: REF_MAX };

/** Campo do catálogo em código ([chave, tipo, obrigatório, opções]) -> objeto `fields` do modelo (M9-D834 §3.1). */
function toField([key, type, required, options]) {
  return { key, label: LABELS[key] || key, type, required: Boolean(required), max_length: MAX_LENGTH[type] || null, enum: type === 'ENUM' ? options : null };
}

/** `fields` -> payload_schema (JSON Schema) usado por M9-D831 e M9-D832 para validar o payload. */
function buildPayloadSchema(fields) {
  const properties = {};
  for (const field of fields) properties[field.key] = { ...FRAGMENTS[field.type](field.enum), 'x-bcpType': field.type, title: field.label };
  return { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties, required: fields.filter((f) => f.required).map((f) => f.key), additionalProperties: true };
}

/** Linha da semente de um formulário do catálogo em código. */
function toTemplateRow(form) {
  const fields = form.fields.map(toField);
  return { sector: form.sector, form_type: form.formType, title: TITLES[form.formType], intended_action: form.action, fields, payload_schema: buildPayloadSchema(fields) };
}

module.exports = { toTemplateRow, buildPayloadSchema, TEXT_MAX, REF_MAX };
