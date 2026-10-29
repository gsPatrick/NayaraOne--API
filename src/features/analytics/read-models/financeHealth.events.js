'use strict';

/**
 * M9-D615 (3.2) — eventos que atualizam os read models do Financeiro. Nomes conferidos em src/features/finance/financeEvents.service.js
 * (técnicos e do caderno). `finance.entry.canceled` e `finance.intercompany.*` ainda não têm quem publique (DI-D615-3): o cancelamento e a
 * posição entre empresas entram pela agenda; assim que o Financeiro publicar o evento, o read model já o consome.
 */
const ENTRY_EVENTS = Object.freeze(['finance.entry.created', 'finance.entry.settled', 'finance.entry.reversed', 'finance.entry.canceled']);
const HEALTH_EVENTS = Object.freeze([
  ...ENTRY_EVENTS,
  'finance.owner_repasse.created', 'finance.owner_repass.completed',
  'finance.commission.created',
  'finance.reconciliation.matched', 'finance.reconciliation.completed',
  'finance.anomaly.opened',
  'finance.third_party_funds.released',
]);

module.exports = { ENTRY_EVENTS, HEALTH_EVENTS };
