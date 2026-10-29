'use strict';

/**
 * M9-D618 (3.2) — eventos que atualizam os read models de Obras, Estoque/Patrimônio e Pós-obra. Os nomes foram conferidos nos serviços de
 * src/features/construction (constructionEvents.service.js, constructionCalendarEvents.service.js) e src/features/inventory
 * (inventoryEvents.service.js) e no Financeiro/Jurídico (DI-D618-1: os nomes do caderno `construction.project.progress_updated`,
 * `construction.daily_report.*`, `construction.measurement.*`, `construction.nonconformity.*`, `construction.maintenance_case.*` e
 * `inventory.tool_loan.*` não existem; valem os que o código publica). O que não tem evento entra pela agenda.
 */
const PROJECT_EVENTS = Object.freeze([
  'project.created', 'project.started', 'construction.project.status_changed', 'project.schedule.updated', 'project.delivered',
  'project.warranty_started', 'project.closed', 'project.delay.detected',
]);
const STAGE_EVENTS = Object.freeze(['project.stage.updated', 'project.stage.completed', 'project.daily_log.created']);
const MEASUREMENT_EVENTS = Object.freeze(['measurement.submitted', 'measurement.approved', 'construction.stage_measurement.decided']);
// Liquidado só deixa de ser custo por estorno (finance.entry.reversed): lançamento cancelado nunca esteve liquidado.
const LEDGER_EVENTS = Object.freeze(['finance.entry.created', 'finance.entry.settled', 'finance.entry.reversed']);
const CONTRACT_EVENTS = Object.freeze(['contract.activated', 'contract.terminated', 'legal.contract.status_changed']);
const NONCONFORMITY_EVENTS = Object.freeze(['nonconformity.opened', 'nonconformity.closed']);
const WARRANTY_EVENTS = Object.freeze(['warranty.case.opened', 'warranty.case.closed', 'warranty.case.escalated']);
const STOCK_EVENTS = Object.freeze([
  'inventory.movement.recorded', 'inventory.stock.low', 'inventory.receipt.completed', 'inventory.count.completed', 'inventory.item.created', 'inventory.loss.opened',
]);
const TOOL_EVENTS = Object.freeze([
  'tool.loan.created', 'tool.loan.overdue', 'tool.returned', 'maintenance.opened', 'maintenance.closed', 'asset.transferred', 'asset.disposed',
]);

module.exports = {
  PROGRESS_EVENTS: Object.freeze([...PROJECT_EVENTS, ...STAGE_EVENTS, 'measurement.approved', 'construction.stage_measurement.decided']),
  COST_EVENTS: Object.freeze([...PROJECT_EVENTS, ...STAGE_EVENTS, ...MEASUREMENT_EVENTS, ...LEDGER_EVENTS, ...CONTRACT_EVENTS, 'project.budget.approved']),
  DELAY_EVENTS: Object.freeze([...PROJECT_EVENTS, 'project.stage.updated', 'project.stage.completed', 'measurement.approved', 'construction.stage_measurement.decided']),
  MEASUREMENT_EVENTS,
  NONCONFORMITY_EVENTS,
  WARRANTY_EVENTS: Object.freeze([...WARRANTY_EVENTS, 'project.warranty_started', 'project.delivered']),
  WASTE_EVENTS: Object.freeze(['inventory.movement.recorded']),
  STOCK_EVENTS,
  TOOL_EVENTS,
};
