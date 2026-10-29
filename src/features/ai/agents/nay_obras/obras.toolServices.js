'use strict';

// M9-D037 — serviço que as tools da NAY Obras chamam (ctx.services.constructionObras). Os limites vêm da configuração da empresa.
const { getSetting } = require('../../../settings/settings.service');
const { OBRAS_SETTING_DEFAULTS: D } = require('./obras.settings');
const data = require('./obras.data');

function constructionObras(transaction, scope = {}) {
  const read = async (key) => Number(await getSetting(key, scope, transaction, D[key])) || D[key];
  const max = () => read('ia.nay_obras.max_itens_lista');
  return {
    getBudgetVsActual: (projectId) => data.budgetVsActual(projectId, transaction),
    getDailyReports: async (projectId) => data.dailyReportsOf(projectId, transaction, { windowDays: await read('ia.nay_obras.diario_janela_dias'), max: await max() }),
    getQualityNonConformities: async (projectId) => data.nonConformitiesOf(projectId, transaction, { max: await max() }),
    getWarrantyCases: async (projectId) => data.warrantyCasesOf(projectId, transaction, { max: await max() }),
  };
}

module.exports = { constructionObras };
