'use strict';

const { getSetting } = require('../../settings/settings.service');
const settings = require('./view.settings');

/**
 * Registro de campos sensíveis por tipo de recurso (M9-D825 §3.1 item 3). Enquanto o registro de classificação (M9-D910) não existe, a fonte é o parâmetro
 * `governanca.dlp.view.campos`. A M9-D910 troca a fonte chamando `setFieldSource` com a mesma assinatura:
 *   source(tenant, resourceType, transaction) -> Promise<{ [campo]: 'LOW'|'MEDIUM'|'HIGH'|'RESTRICTED' }>   (vazio = tipo sem campo sensível)
 * A chave do campo é comparada sem diferenciar maiúsculas nem `_` (taxIdNormalized = tax_id_normalized).
 */
const normalizeKey = (key) => String(key).replace(/_/g, '').toLowerCase();

async function settingSource(tenant, resourceType, transaction) {
  const text = await getSetting(settings.FIELDS_KEY, tenant, transaction, settings.VIEW_SETTING_DEFAULTS[settings.FIELDS_KEY]);
  return settings.fieldsOf(text)[resourceType] || {};
}

let current = settingSource;
const setFieldSource = (fn) => { current = fn; };
const resetFieldSource = () => { current = settingSource; };

/** Mapa { chaveNormalizada: classe } dos campos HIGH e RESTRICTED do tipo (LOW e MEDIUM não têm política de VIEW e COPY). */
async function sensitiveFields(tenant, resourceType, transaction) {
  const raw = await current(tenant, resourceType, transaction);
  const out = {};
  for (const [field, classification] of Object.entries(raw || {})) {
    if (classification === 'HIGH' || classification === 'RESTRICTED') out[normalizeKey(field)] = classification;
  }
  return out;
}

/** Classe de um campo do tipo (qualquer classe, inclusive LOW e MEDIUM); null se o campo não existe no registro. */
async function classOfField(tenant, resourceType, field, transaction) {
  const raw = (await current(tenant, resourceType, transaction)) || {};
  const found = Object.entries(raw).find(([name]) => normalizeKey(name) === normalizeKey(field));
  return found ? found[1] : null;
}

module.exports = { setFieldSource, resetFieldSource, sensitiveFields, classOfField, normalizeKey };
