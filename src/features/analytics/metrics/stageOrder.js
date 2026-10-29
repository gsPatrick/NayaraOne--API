'use strict';

/**
 * M9-D634 — ordem dos estágios para exibir o funil, lida dos parâmetros do administrador (nunca de lista no código):
 * CRM = `analytics.comercial.ordem_estagios`; Correspondente = `analytics.correspondente.estagios_validos`. Porta da camada de métricas para os painéis.
 */
const { readCrmKpiParams } = require('../read-models/crmKpi.settings');
const { readJurCorKpiParams } = require('../read-models/juridicoCorrespondenteKpi.settings');

const READERS = Object.freeze({
  CRM: async (scope, transaction) => (await readCrmKpiParams(scope, transaction)).stageOrder,
  COR: async (scope, transaction) => (await readJurCorKpiParams(scope, transaction)).validStages,
});

/** kind: 'CRM' | 'COR'. Devolve a lista de códigos na ordem do administrador. */
const readStageOrder = (kind, scope, transaction) => READERS[kind](scope, transaction);

module.exports = { readStageOrder };
