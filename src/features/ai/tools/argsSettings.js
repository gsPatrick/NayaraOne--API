'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const { ARGS_SETTING_DEFAULTS } = require('./args.settings');

const STRING_KEY = 'ia.tool.string_max_caracteres';
const ARRAY_KEY = 'ia.tool.array_max_itens';

async function inteiroPositivo(chave, tenant, transaction) {
  const padrao = ARGS_SETTING_DEFAULTS[chave];
  const n = Number(await getSetting(chave, tenant, transaction, padrao));
  return Number.isInteger(n) && n >= 1 ? n : padrao;
}

/** Limites vigentes da empresa (valor corrompido volta ao padrão conservador). Chamar com a transação do tenant (RLS). */
async function loadArgsLimits(tenant, transaction) {
  return {
    stringMax: await inteiroPositivo(STRING_KEY, tenant, transaction),
    arrayMax: await inteiroPositivo(ARRAY_KEY, tenant, transaction),
  };
}

module.exports = { loadArgsLimits, STRING_KEY, ARRAY_KEY };
