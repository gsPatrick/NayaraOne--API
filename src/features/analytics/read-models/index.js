'use strict';

// M9-D613 — API pública da camada read-models do BI. M9-D607 acrescenta o registro dos read models, o worker de eventos e o refresh agendado.
const registry = require('./readModel.registry');
const consumer = require('./readModel.consumer');
const { applyEvent } = require('./readModel.worker');
const { refreshCompanyScheduled } = require('./readModel.scheduled');
const { readRefreshParams } = require('./readModel.settings');
const { scheduleDue, afterRun } = require('./readModel.schedule');
const { onBatchFlushed } = require('./readModel.batch');
const { readAggregate, assertReadModelTable } = require('./readModel.read');
const { rebuildReadModel } = require('./rebuild.service');
const { onRebuildChecks } = require('./rebuild.checks');
const { readRebuildParams } = require('./rebuild.settings');
const matviews = require('./matview.registry');
const { refreshMaterializedView } = require('./matview.refresh');
const { readMaterializedView } = require('./matview.read');
const { MV_DEFAULTS, parseMvSchedule, readMvParams } = require('./matview.settings');
const { onRefreshed } = require('./readModel.refreshed');

consumer.install(); // liga o worker ao outbox: cada registerReadModel passa a receber os eventos dos seus tipos
require('./financeiro-finance-health.readmodel'); // M9-D615: saúde financeira por empresa e data-base
require('./financeiro-finance-sector-margin.readmodel'); // M9-D615: margem por setor
require('./financeiro-finance-intercompany.readmodel'); // M9-D625: transferências entre empresas (eliminação do intercompany no consolidado)
require('./matview.finance'); // M9-D698: série mensal do caixa (materialized view)
require('./comercial-imoveis.readmodel'); // M9-D616: Comercial/CRM e Imóveis
require('./locacao.readmodel'); // M9-D617: Locação
require('./obras-estoque-patrimonio-pos-obra.readmodel'); // M9-D618: Obras, Estoque/Patrimônio e Pós-obra
require('./juridico-correspondente.readmodel'); // M9-D619: Jurídico e Correspondente Bancário
require('./marketing-atendimento.readmodel'); // M9-D627: Marketing e Atendimento/Satisfação
require('./tecnologia-seguranca-ia.readmodel'); // M9-D628: Tecnologia, Integrações, Segurança e IA
require('./decisao-fila.readmodel'); // M9-D709: fila de decisão do Centro de Comando
require('./command-events.readmodel'); // M9-D710: fatos do dia do Centro de Comando (contratos assinados, oportunidades ganhas, pagamentos liquidados)

module.exports = {
  camada: 'read-models',
  registerReadModel: registry.registerReadModel,
  unregisterReadModel: registry.unregisterReadModel,
  getReadModel: registry.getReadModel,
  listReadModels: registry.listReadModels,
  applyEvent,
  refreshCompanyScheduled,
  readRefreshParams,
  scheduleDue,
  afterRun,
  onBatchFlushed,
  readAggregate,
  readIntercompanyPairs: require('./intercompany.read').readIntercompanyPairs, // M9-D625
  listDecisionQueue: require('./decisao-fila.list').listDecisionQueue, // M9-D709: fila de decisão do Centro de Comando
  assertReadModelTable,
  rebuildReadModel,
  onRebuildChecks,
  readRebuildParams,
  registerMaterializedView: matviews.registerMaterializedView,
  unregisterMaterializedView: matviews.unregisterMaterializedView,
  listMaterializedViews: matviews.listMaterializedViews,
  refreshMaterializedView,
  readMaterializedView,
  MV_DEFAULTS,
  parseMvSchedule,
  readMvParams,
  onRefreshed,
};
