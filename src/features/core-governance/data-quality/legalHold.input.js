'use strict';

const errors = require('./legalHold.errors');
const { ENTITY_TYPES, SCOPE_TYPES, STATUS, CODE_PATTERN } = require('./legalHold.constants');
const { TABLES } = require('./legalHold.catalog');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isUuid = (value) => UUID.test(String(value || ''));
const validDay = (value) => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** Um item de escopo, já normalizado: { type, id? , entityType?, from?, to? }. Item fora do vocabulário é 422 GOV_HOLD_SCOPE_INVALID. */
function parseScopeItem(raw, index) {
  const at = { index };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw errors.scopeInvalid('Cada item do escopo deve ser um objeto.', at);
  const type = text(raw.type).toUpperCase();
  if (!SCOPE_TYPES[type]) throw errors.scopeInvalid('Tipo de item do escopo desconhecido.', { ...at, allowed: Object.keys(SCOPE_TYPES) });
  if (type === SCOPE_TYPES.COMPANY) return { type };
  if (type === SCOPE_TYPES.DATA_TYPE || type === SCOPE_TYPES.ENTITY) {
    const entityType = text(raw.entity_type).toUpperCase();
    if (!ENTITY_TYPES.includes(entityType)) throw errors.scopeInvalid('Tipo de registro desconhecido.', { ...at, allowed: ENTITY_TYPES });
    if (type === SCOPE_TYPES.ENTITY) {
      if (!text(raw.id) || text(raw.id).length > 64) throw errors.scopeInvalid('Informe o id do registro.', at);
      return { type, entityType, id: text(raw.id).toLowerCase() };
    }
    const from = raw.from === undefined || raw.from === null ? null : text(raw.from);
    const to = raw.to === undefined || raw.to === null ? null : text(raw.to);
    if ((from && !validDay(from)) || (to && !validDay(to))) throw errors.scopeInvalid('O período deve usar datas AAAA-MM-DD.', at);
    if (from && to && from > to) throw errors.scopeInvalid('O início do período deve ser anterior ao fim.', at);
    if ((from || to) && !TABLES[entityType]) throw errors.scopeInvalid('Este tipo de registro não aceita período.', at);
    return { type, entityType, from, to };
  }
  if (!isUuid(raw.id)) throw errors.scopeInvalid('Informe o id (UUID) do registro do escopo.', at);
  return { type, id: String(raw.id).toLowerCase() };
}

/** POST /legal-holds: código, motivo e referência (obrigatórios), escopo (lista não vazia, até `maxItems`). */
function parseCreate(body, maxItems) {
  const b = body && typeof body === 'object' ? body : {};
  const code = text(b.code);
  if (!CODE_PATTERN.test(code)) throw errors.validation('O código da retenção deve ter até 40 caracteres (letras, números, ponto, hífen e sublinhado).', { field: 'code' });
  const reason = text(b.reason);
  const matterRef = text(b.matter_ref);
  if (!reason || !matterRef) throw errors.reasonRequired();
  if (matterRef.length > 120) throw errors.validation('A referência do processo deve ter até 120 caracteres.', { field: 'matter_ref' });
  if (!Array.isArray(b.scope) || !b.scope.length) throw errors.scopeRequired();
  if (b.scope.length > maxItems) throw errors.scopeInvalid(`O escopo aceita até ${maxItems} itens.`, { max: maxItems });
  const scope = b.scope.map(parseScopeItem);
  const unique = new Map(scope.map((item) => [JSON.stringify(item), item]));
  return { code, reason, matterRef, scope: [...unique.values()] };
}

/** POST /legal-holds/:id/release: o motivo da liberação é obrigatório. */
function parseRelease(body) {
  const reason = text(body && body.release_reason);
  if (!reason) throw errors.releaseReasonRequired();
  return { reason };
}

function parseListQuery(query) {
  const status = query.status === undefined ? null : text(query.status).toUpperCase();
  if (status && !STATUS[status]) throw errors.validation('Situação inválida.', { field: 'status', allowed: Object.keys(STATUS) });
  return { status, code: query.code === undefined ? null : text(query.code) };
}

module.exports = { parseCreate, parseRelease, parseListQuery, parseScopeItem, isUuid };
