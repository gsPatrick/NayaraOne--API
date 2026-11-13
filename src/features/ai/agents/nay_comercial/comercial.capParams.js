'use strict';

// Leitura, a cada consulta, dos parâmetros das capacidades da NAY Comercial do livro do Marco 3 §12/§16 (comercial.capabilities.settings.js).
// Valor inválido volta ao padrão (nunca derruba a resposta).
const { getSetting } = require('../../../settings/settings.service');
const { termsOf } = require('../scope/scope.evaluate');
const { CAP_KEYS: K, CAP_SETTING_DEFAULTS: D, CAP_SETTINGS_SCHEMA: S } = require('./comercial.capabilities.settings');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, D[key]);

async function int(key, tenant, transaction) {
  const v = await read(key, tenant, transaction);
  const spec = S[key];
  return Number.isInteger(v) && v >= spec.min && v <= spec.max ? v : D[key];
}

async function bool(key, tenant, transaction) {
  const v = await read(key, tenant, transaction);
  return typeof v === 'boolean' ? v : D[key];
}

async function oneOf(key, tenant, transaction) {
  const v = await read(key, tenant, transaction);
  return S[key].enum.includes(v) ? v : D[key];
}

const terms = async (key, tenant, transaction) => termsOf(await read(key, tenant, transaction), D[key]);

/** "RG|CIN,CNPJ" -> [['RG','CIN'], ['CNPJ']] (grupos de documentos exigidos; cada grupo é satisfeito por qualquer alternativa). */
function documentGroups(raw, fallback) {
  const parse = (text) => String(text || '').split(',').map((g) => g.split('|').map((d) => d.trim().toUpperCase()).filter(Boolean)).filter((g) => g.length);
  const groups = parse(raw);
  return groups.length ? groups : parse(fallback);
}

async function readForgottenParams(tenant, transaction) {
  return {
    enabled: await bool(K.forgottenEnabled, tenant, transaction),
    days: await int(K.forgottenDays, tenant, transaction),
    intervalHours: await int(K.forgottenIntervalHours, tenant, transaction),
    listMax: await int(K.forgottenListMax, tenant, transaction),
  };
}

async function readQualityParams(tenant, transaction) {
  const good = await int(K.qualityGood, tenant, transaction);
  const fair = await int(K.qualityFair, tenant, transaction);
  return {
    docsPf: documentGroups(await read(K.docsPf, tenant, transaction), D[K.docsPf]),
    docsPj: documentGroups(await read(K.docsPj, tenant, transaction), D[K.docsPj]),
    // Nota de REGULAR acima da de BOM não faz sentido: vale o padrão das duas.
    good: fair < good ? good : D[K.qualityGood],
    fair: fair < good ? fair : D[K.qualityFair],
  };
}

async function readMessageParams(tenant, transaction) {
  return {
    summaryChars: await int(K.messageSummaryChars, tenant, transaction),
    terms: {
      CONFLICT: await terms(K.termsConflict, tenant, transaction),
      POOR_SERVICE: await terms(K.termsPoorService, tenant, transaction),
      COMPLAINT: await terms(K.termsComplaint, tenant, transaction),
      PENDING_RETURN: await terms(K.termsPendingReturn, tenant, transaction),
      COMPLIMENT: await terms(K.termsCompliment, tenant, transaction),
    },
  };
}

async function readSendParams(tenant, transaction) {
  return { purpose: await oneOf(K.sendPurpose, tenant, transaction), channel: await oneOf(K.sendChannel, tenant, transaction) };
}

const draftByModel = (tenant, transaction) => bool(K.draftByModel, tenant, transaction);
const descriptionTerms = (tenant, transaction) => terms(K.descriptionTerms, tenant, transaction);

module.exports = { readForgottenParams, readQualityParams, readMessageParams, readSendParams, draftByModel, descriptionTerms, documentGroups };
