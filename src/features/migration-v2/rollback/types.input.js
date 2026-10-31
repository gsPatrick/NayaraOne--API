'use strict';

const errors = require('./rollback.errors');
const { REVERSIBILITY, NEEDS_COMPENSATION, FIELD_MAX } = require('./rollback.constants');

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENTITY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPERATION_RE = /^[A-Za-z][A-Za-z0-9]{1,63}$/;

const text = (value, max, label) => {
  const out = typeof value === 'string' ? value.trim() : '';
  if (out.length > max) throw errors.invalid(`${label} aceita até ${max} caracteres.`);
  return out;
};

/** Um tipo do corpo de PUT /migration/external-ops, validado e normalizado (M9-D907 §3.1 e §4). */
function normalizeType(raw) {
  if (!raw || typeof raw !== 'object') throw errors.invalid('Cada tipo de operação deve ser um objeto.');
  const code = String(raw.code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw errors.invalid('O código do tipo deve ter letras maiúsculas, dígitos e _ (2 a 64 caracteres).', { code: raw.code });
  const reversibility = String(raw.reversibility || '').trim().toUpperCase();
  if (!REVERSIBILITY[reversibility]) throw errors.invalid('A reversibilidade deve ser REVERSIBLE, COMPENSABLE ou IRREVERSIBLE.', { code, reversibility: raw.reversibility });
  const compensation = text(raw.compensation, FIELD_MAX.text, 'A compensação');
  const procedure = text(raw.procedure, FIELD_MAX.text, 'O procedimento');
  const owner = text(raw.owner, FIELD_MAX.owner, 'O responsável');
  if (!compensation || (NEEDS_COMPENSATION.includes(reversibility) && !procedure)) throw errors.compensationRequired({ code, missing: [!compensation && 'compensation', NEEDS_COMPENSATION.includes(reversibility) && !procedure && 'procedure'].filter(Boolean) });
  if (!owner) throw errors.invalid('Informe o responsável pela compensação deste tipo.', { code });
  const entity = raw.entity ? String(raw.entity).trim().toUpperCase() : null;
  if (entity && !ENTITY_RE.test(entity)) throw errors.invalid('A entidade deve ter letras maiúsculas, dígitos e _.', { code, entity: raw.entity });
  const operations = raw.operations === undefined ? undefined : raw.operations;
  if (operations !== undefined && (!Array.isArray(operations) || operations.some((op) => typeof op !== 'string' || !OPERATION_RE.test(op.trim())))) {
    throw errors.invalid('As operações do tipo devem ser nomes de operação de envio (letras e dígitos).', { code });
  }
  return { code, module: text(raw.module, FIELD_MAX.module, 'O módulo').toUpperCase() || 'GENERAL', reversibility, compensation, procedure, owner, entity, operations: operations ? [...new Set(operations.map((op) => op.trim()))] : undefined };
}

/** Corpo `{ types: [...] }` inteiro (nada é gravado se um tipo for inválido). */
function normalizeBody(body) {
  if (!body || !Array.isArray(body.types) || body.types.length === 0) throw errors.invalid('Informe a lista de tipos de operação externa.');
  const types = body.types.map(normalizeType);
  const seen = new Set();
  for (const t of types) {
    if (seen.has(t.code)) throw errors.invalid('Tipo repetido na lista.', { code: t.code });
    seen.add(t.code);
  }
  return types;
}

module.exports = { normalizeType, normalizeBody };
