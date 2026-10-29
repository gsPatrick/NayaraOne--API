'use strict';

// M9-D035/D038/D039 — leituras compartilhadas entre agentes: a mesma tool devolve agregado ou lista nominal conforme o escopo de dados do agente chamador.
const { getExpiringContracts } = require('../../legal/expiringContracts.service');
const { getStalledSummary } = require('../../correspondent/stalledSummary.service');
const { getSetting } = require('../../settings/settings.service');
const { wantsDetail } = require('./summaryScope');
const { DIRETORIA_KEYS, DIRETORIA_SETTING_DEFAULTS } = require('../agents/nay_diretoria/diretoria.settings');

const tenantOf = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId });

/** Faixas em dias, em ordem crescente e sem repetição; texto inválido volta ao padrão (nunca derruba a leitura). */
function parseBands(text) {
  const nums = String(text).split(',').map((s) => Number.parseInt(s.trim(), 10));
  const ok = nums.length > 0 && nums.every((n) => Number.isInteger(n) && n > 0 && n <= 3650);
  const list = ok ? [...new Set(nums)].sort((a, b) => a - b) : null;
  return list || parseBands(DIRETORIA_SETTING_DEFAULTS[DIRETORIA_KEYS.contractBands]);
}

function legalExpiring(transaction, scope) {
  return {
    async getExpiring() {
      const bands = parseBands(await getSetting(DIRETORIA_KEYS.contractBands, tenantOf(scope), transaction, DIRETORIA_SETTING_DEFAULTS[DIRETORIA_KEYS.contractBands]));
      return getExpiringContracts(transaction, { bands, detail: wantsDetail(scope, 'legal') });
    },
  };
}

/**
 * Casos parados: o serviço do Correspondente (M9-D039) já devolve a lista nominal; para um agente sem escopo nominal da área (a Diretoria,
 * `correspondent.summary`) a mesma chamada devolve só o agregado por etapa. `base` é o serviço de casos de operations.services.js.
 */
function withStalledScope(base, transaction, scope) {
  return {
    ...base,
    getStalledCases: (...args) => (wantsDetail(scope, 'correspondent') ? base.getStalledCases(...args) : getStalledSummary(scope.groupId, scope.companyId, transaction)),
  };
}

module.exports = { legalExpiring, withStalledScope, parseBands };
