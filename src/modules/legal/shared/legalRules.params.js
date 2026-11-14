'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const { isValidZone } = require('../../../features/migration-v2/timezone/timezone.convert');
const {
  KEY_DELIVERY_PHOTO_TYPES, PHOTO_DEFAULTS, CRITICALITIES, RECEIVABLE_BASES, RECEIVABLE_BASES_ON_BY_DEFAULT,
  DEFAULT_ZONE, DEFAULT_DUE_SOON_HOURS, DEFAULT_ESCALATION_HOURS, keys,
} = require('./legalRules.settings');

/** Leitura dos parâmetros da Locação e do Jurídico (dicionário e padrões em legalRules.settings.js). */
const { photoKey, dueSoonKey, escalationKey, basisKey, ZONE_KEY } = keys;

const intOr = (value, fallback, min, max) => (Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback);

/** Quantidade mínima de fotos da entrega: pelo termo de imóvel usado, senão pelo tipo de contrato. */
async function keyDeliveryMinPhotos(contractType, termType, tenant, transaction) {
  const policyType = termType === 'USED_PROPERTY_DELIVERY' ? 'USED_PROPERTY_DELIVERY' : contractType;
  const fallback = PHOTO_DEFAULTS[policyType] || 0;
  if (!KEY_DELIVERY_PHOTO_TYPES.includes(policyType)) return { policyType, minPhotos: fallback };
  const value = await getSetting(photoKey(policyType), tenant, transaction, fallback);
  return { policyType, minPhotos: intOr(value, fallback, 0, 50) };
}

/** Fuso IANA dos prazos jurídicos da empresa (inválido ou ausente = padrão). */
async function legalDeadlineZone(tenant, transaction) {
  const value = await getSetting(ZONE_KEY, tenant, transaction, DEFAULT_ZONE);
  return typeof value === 'string' && isValidZone(value.trim()) ? value.trim() : DEFAULT_ZONE;
}

/** Janelas de alerta por criticidade: { LOW: { dueSoonHours, escalationHours }, ... }. */
async function legalDeadlineWindows(tenant, transaction) {
  const out = {};
  for (const crit of CRITICALITIES) {
    const dueSoon = await getSetting(dueSoonKey(crit), tenant, transaction, DEFAULT_DUE_SOON_HOURS);
    const escalation = await getSetting(escalationKey(crit), tenant, transaction, DEFAULT_ESCALATION_HOURS);
    out[crit] = { dueSoonHours: intOr(dueSoon, DEFAULT_DUE_SOON_HOURS, 1, 720), escalationHours: intOr(escalation, DEFAULT_ESCALATION_HOURS, 1, 720) };
  }
  return out;
}

function windowFor(windows, criticality) {
  return (windows && windows[criticality]) || { dueSoonHours: DEFAULT_DUE_SOON_HOURS, escalationHours: DEFAULT_ESCALATION_HOURS };
}

/** Bases jurídicas que a empresa aceita hoje para o recebível do processo. */
async function enabledReceivableBases(tenant, transaction) {
  const enabled = [];
  for (const code of Object.keys(RECEIVABLE_BASES)) {
    const value = await getSetting(basisKey(code), tenant, transaction, RECEIVABLE_BASES_ON_BY_DEFAULT.includes(code));
    if (value === true || value === 'true') enabled.push(code);
  }
  return enabled;
}

module.exports = { keyDeliveryMinPhotos, legalDeadlineZone, legalDeadlineWindows, windowFor, enabledReceivableBases };
