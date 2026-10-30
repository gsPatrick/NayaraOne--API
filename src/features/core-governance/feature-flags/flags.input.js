'use strict';

const { KINDS, VALUE_TYPES, SCOPES, RISKS, KEY_RE, KEY_MAX } = require('./flags.constants');
const { ENVIRONMENTS } = require('../finops/finops.constants');
const { isUuid } = require('../finops/budgets/budget.input');
const { checkValue, checkAllowed } = require('./flags.value');
const E = require('./flags.errors');
const { parseKillSwitch } = require('./kill-switch/killSwitch.input');

const CREATE_FIELDS = ['key', 'kind', 'value', 'valueType', 'allowedValues', 'ownerUserId', 'scope', 'scopeRef', 'risk', 'validFrom', 'validUntil', 'temporary', 'description', 'isKillSwitch', 'probe', 'reason'];
const PATCH_FIELDS = ['id', 'key', 'confirmation', 'version', 'reason', 'value', 'ownerUserId', 'scope', 'scopeRef', 'risk', 'validFrom', 'validUntil', 'temporary', 'description'];
const IMMUTABLE = ['key', 'kind', 'valueType', 'allowedValues', 'isKillSwitch', 'probe'];

const isMissing = (v) => v === undefined || v === null || v === '';
const upper = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v);

function rejectUnknown(body, allowed) {
  for (const field of Object.keys(body)) {
    if (allowed.includes(field)) continue;
    const why = IMMUTABLE.includes(field) ? `O campo "${field}" não pode ser alterado depois que a chave existe.` : `Campo desconhecido: "${field}".`;
    throw E.inputInvalid(why, { field });
  }
}

function parseDate(value, field) {
  if (isMissing(value)) return null;
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) throw E.inputInvalid(`Data inválida em "${field}".`, { field });
  return date;
}

function parseOwner(value) {
  if (isMissing(value)) throw E.ownerRequired();
  if (!isUuid(value)) throw E.ownerInvalid();
  return value;
}

/** Escopo e referência: GLOBAL sem referência; GROUP/COMPANY só a própria empresa; ENVIRONMENT da lista de ambientes; USER uuid; SECTOR texto curto. */
function parseScope(scopeIn, refIn, tenant) {
  const scope = upper(isMissing(scopeIn) ? 'GLOBAL' : scopeIn);
  if (!SCOPES.includes(scope)) throw E.inputInvalid(`Escopo desconhecido: ${scope}.`, { field: 'scope', allowed: SCOPES });
  if (scope === 'GLOBAL') {
    if (!isMissing(refIn)) throw E.inputInvalid('O escopo GLOBAL não tem referência.', { field: 'scopeRef' });
    return { scope, scopeRef: null };
  }
  if (isMissing(refIn)) throw E.inputInvalid(`Informe a referência do escopo ${scope} (scopeRef).`, { field: 'scopeRef' });
  const ref = String(refIn).trim();
  if (scope === 'GROUP' && ref !== tenant.groupId) throw E.inputInvalid('A chave de grupo só vale para o grupo desta empresa.', { field: 'scopeRef' });
  if (scope === 'COMPANY' && ref !== tenant.companyId) throw E.inputInvalid('A chave de empresa só vale para esta empresa.', { field: 'scopeRef' });
  if (scope === 'ENVIRONMENT' && !ENVIRONMENTS.includes(ref.toUpperCase())) throw E.inputInvalid('Ambiente desconhecido.', { field: 'scopeRef', allowed: ENVIRONMENTS });
  if (scope === 'USER' && !isUuid(ref)) throw E.inputInvalid('A referência do escopo USER deve ser o id da pessoa.', { field: 'scopeRef' });
  if (ref.length > 64) throw E.inputInvalid('Referência de escopo longa demais.', { field: 'scopeRef' });
  return { scope, scopeRef: scope === 'ENVIRONMENT' ? ref.toUpperCase() : ref };
}

function parseValidity(from, until) {
  const validFrom = parseDate(from, 'validFrom');
  const validUntil = parseDate(until, 'validUntil');
  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) throw E.validityInvalid();
  return { validFrom, validUntil };
}

const parseRisk = (value, fallback) => {
  const risk = upper(isMissing(value) ? fallback : value);
  if (!RISKS.includes(risk)) throw E.inputInvalid(`Risco desconhecido: ${risk}.`, { field: 'risk', allowed: RISKS });
  return risk;
};

const parseDescription = (value) => {
  if (isMissing(value)) return null;
  if (typeof value !== 'string' || value.length > 1000) throw E.inputInvalid('Descrição inválida (texto de até 1000 caracteres).', { field: 'description' });
  return value.trim() || null;
};

/** Corpo do POST: entrada normalizada e validada (o responsável ativo da empresa é conferido pelo serviço). */
function parseCreate(body, tenant, params) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  rejectUnknown(b, CREATE_FIELDS);
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (!key || key.length > KEY_MAX || !KEY_RE.test(key)) throw E.inputInvalid('A chave deve ter o formato dominio.recurso.nome, em minúsculas.', { field: 'key' });
  const kind = upper(isMissing(b.kind) ? KINDS.FLAG : b.kind);
  if (!KINDS[kind]) throw E.inputInvalid(`Tipo desconhecido: ${kind}.`, { field: 'kind', allowed: Object.keys(KINDS) });
  const valueType = upper(isMissing(b.valueType) ? (kind === KINDS.FLAG ? 'BOOLEAN' : '') : b.valueType);
  if (!VALUE_TYPES.includes(valueType)) throw E.inputInvalid('Informe o tipo do valor (valueType).', { field: 'valueType', allowed: VALUE_TYPES });
  if (kind === KINDS.FLAG && valueType !== 'BOOLEAN') throw E.valueInvalid({ valueType, reason: 'a flag é sempre booleana' });
  const ownerUserId = parseOwner(b.ownerUserId);
  const allowedValues = checkAllowed(valueType, b.allowedValues);
  if (valueType !== 'ENUM' && !isMissing(b.allowedValues)) throw E.inputInvalid('allowedValues só vale para o tipo ENUM.', { field: 'allowedValues' });
  const value = checkValue(valueType, b.value, { allowedValues, max: params.valueMax });
  const { scope, scopeRef } = parseScope(b.scope, b.scopeRef, tenant);
  const { validFrom, validUntil } = parseValidity(b.validFrom, b.validUntil);
  for (const field of ['temporary', 'isKillSwitch']) if (b[field] !== undefined && typeof b[field] !== 'boolean') throw E.inputInvalid(`"${field}" deve ser verdadeiro ou falso.`, { field });
  if (b.temporary === true && !validUntil) throw E.expiryRequired();
  const kill = parseKillSwitch({ isKillSwitch: b.isKillSwitch === true, kind, probe: b.probe, risk: b.risk });
  return {
    key, kind, value, valueType, allowedValues, ownerUserId, scope, scopeRef, risk: kill.risk || parseRisk(b.risk, params.defaultRisk), validFrom, validUntil,
    temporary: Boolean(b.temporary), description: parseDescription(b.description), isKillSwitch: kill.isKillSwitch, probe: kill.probe,
  };
}

/** Corpo do PATCH: só os campos enviados, validados contra a chave atual (`current` em snake_case). */
function parsePatch(body, current, tenant, params) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  rejectUnknown(b, PATCH_FIELDS);
  const has = (field) => b[field] !== undefined;
  const patch = {};
  if (has('value')) patch.value = checkValue(current.value_type, b.value, { allowedValues: current.allowed_values, max: params.valueMax });
  if (has('ownerUserId')) patch.ownerUserId = parseOwner(b.ownerUserId);
  if (has('scope') || has('scopeRef')) Object.assign(patch, parseScope(has('scope') ? b.scope : current.scope, has('scopeRef') ? b.scopeRef : (has('scope') ? undefined : current.scope_ref), tenant));
  if (has('risk')) {
    patch.risk = parseRisk(b.risk);
    if (current.is_kill_switch && patch.risk !== 'CRITICAL') throw E.inputInvalid('Kill switch tem risco CRITICAL.', { field: 'risk' });
  }
  if (has('validFrom') || has('validUntil')) {
    const from = has('validFrom') ? b.validFrom : current.valid_from;
    const until = has('validUntil') ? b.validUntil : current.valid_until;
    Object.assign(patch, parseValidity(from instanceof Date ? from.toISOString() : from, until instanceof Date ? until.toISOString() : until));
  }
  if (has('temporary')) {
    if (typeof b.temporary !== 'boolean') throw E.inputInvalid('"temporary" deve ser verdadeiro ou falso.', { field: 'temporary' });
    patch.temporary = b.temporary;
  }
  if (has('description')) patch.description = parseDescription(b.description);
  return patch;
}

const parseReason = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw E.reasonRequired();
  return value.trim().slice(0, 500);
};

module.exports = { parseCreate, parsePatch, parseReason, parseOwner, isMissing };
