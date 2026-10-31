'use strict';

const { getSetting } = require('../../settings/settings.service');
const S = require('./canary.settings');

/** Leitura dos parâmetros do canary (sempre por getSetting; valor inválido gravado por fora cai no padrão). */
async function readStages(tenant, transaction) {
  const raw = await getSetting(S.STAGES_KEY, tenant, transaction, S.CANARY_SETTING_DEFAULTS[S.STAGES_KEY]);
  return S.parseStages(raw) || S.parseStages(S.CANARY_SETTING_DEFAULTS[S.STAGES_KEY]);
}

async function readEntities(tenant, sector, transaction) {
  const key = S.entitiesKey(sector);
  const raw = await getSetting(key, tenant, transaction, S.CANARY_SETTING_DEFAULTS[key]);
  return S.parseEntities(raw) || S.parseEntities(S.CANARY_SETTING_DEFAULTS[key]);
}

const readRequireComparison = async (tenant, transaction) => Boolean(await getSetting(S.REQUIRE_COMPARISON_KEY, tenant, transaction, S.CANARY_SETTING_DEFAULTS[S.REQUIRE_COMPARISON_KEY]));

module.exports = { readStages, readEntities, readRequireComparison };
