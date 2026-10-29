'use strict';

// M9-D710 — KPIs de fatos do dia do Centro de Comando: definição no registry, cálculo a partir do read model e gravação do snapshot a cada refresh.
const commandEvents = require('./set');

commandEvents.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  COMMAND_EVENT_KPI_DEFINITIONS: commandEvents.definitions,
  ensureCommandEventKpisPublished: commandEvents.ensurePublished,
  materializeCommandEventKpis: commandEvents.materialize,
  buildCommandEventKpiEntries: commandEvents.buildEntries,
  installCommandEventKpis: () => { commandEvents.install(); },
};
