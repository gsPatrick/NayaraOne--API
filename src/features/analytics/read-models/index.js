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

consumer.install(); // liga o worker ao outbox: cada registerReadModel passa a receber os eventos dos seus tipos
require('./financeiro-finance-health.readmodel'); // M9-D615: saúde financeira por empresa e data-base
require('./financeiro-finance-sector-margin.readmodel'); // M9-D615: margem por setor
require('./comercial-imoveis.readmodel'); // M9-D616: Comercial/CRM e Imóveis
require('./obras-estoque-patrimonio-pos-obra.readmodel'); // M9-D618: Obras, Estoque/Patrimônio e Pós-obra
require('./marketing-atendimento.readmodel'); // M9-D627: Marketing e Atendimento/Satisfação

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
  assertReadModelTable,
  rebuildReadModel,
  onRebuildChecks,
  readRebuildParams,
};
