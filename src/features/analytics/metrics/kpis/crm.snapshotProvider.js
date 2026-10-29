'use strict';

/**
 * M9-D630 / M9-D631 / M9-D609 — provedor do snapshot diário para os KPIs do funil comercial: calcula, com o estado atual dos read models do CRM, o
 * mesmo resultado (valor, dimensões, hash, sourceRefs) que o refresh grava ao vivo. Os read models não guardam histórico (M9-D604): o estado só serve
 * para o dia de hoje. Para uma data anterior (o D-1 do job das 00:30) o provedor devolve lista vazia e vale o último snapshot gravado ao vivo naquele
 * dia (a última revisão do dia é a posição de fim de dia); nada é inventado.
 */
const clock = require('../clock');
const { buildCrmKpiEntries } = require('./crm.entries');
const { DEFINITIONS } = require('./crm.definitions');
const { registerSnapshotProvider } = require('../snapshots.providers');

const provider = {
  name: 'crm-kpis',
  metricCodes: DEFINITIONS.map((d) => d.metricCode),
  async build(scope, asOfDate, transaction) {
    if (asOfDate !== clock.businessToday()) return [];
    return (await buildCrmKpiEntries(scope, asOfDate, transaction)).map((e) => ({ code: e.code, inputs: e.inputs }));
  },
};

const register = () => registerSnapshotProvider(provider);

module.exports = { provider, register };
