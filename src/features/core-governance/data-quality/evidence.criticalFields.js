'use strict';

const { getSetting } = require('../../settings/settings.service');
const settings = require('./evidence.settings');

/** Lista vigente de campos críticos da empresa (itens FAMÍLIA.campo); lista vazia ou inválida volta ao padrão do item 3.1. */
async function criticalFieldsFor(tenant, transaction) {
  const stored = await getSetting(settings.CRITICAL_FIELDS_KEY, tenant, transaction, settings.DEFAULT_CRITICAL_FIELDS);
  const parsed = settings.parseCriticalFields(stored);
  return parsed.length ? parsed : settings.parseCriticalFields(settings.DEFAULT_CRITICAL_FIELDS);
}

/** Valor comparável: nulo e texto vazio são o mesmo "sem valor"; data vira AAAA-MM-DD; objeto vira JSON. */
function comparable(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Campos do patch que são críticos para as famílias da entidade E mudam o valor. `entity.current` traz os valores de hoje;
 * campo ausente do patch não conta; mesmo valor não é alteração (idempotência).
 */
function changedCriticalFields(entity, patch, criticalList) {
  const families = entity.families && entity.families.length ? entity.families : [entity.type];
  const critical = new Set(criticalList.filter((item) => families.includes(item.split('.')[0])).map((item) => item.slice(item.indexOf('.') + 1)));
  const current = entity.current || {};
  return Object.keys(patch || {})
    .filter((field) => critical.has(field) && patch[field] !== undefined)
    .filter((field) => comparable(current[field]) !== comparable(patch[field]))
    .sort()
    .map((field) => ({ field, before: comparable(current[field]), after: comparable(patch[field]) }));
}

module.exports = { criticalFieldsFor, changedCriticalFields, comparable };
