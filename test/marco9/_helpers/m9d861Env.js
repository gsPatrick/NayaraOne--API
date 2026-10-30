'use strict';

// Apoio dos testes M9-D861 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { QueryTypes } = require('sequelize');
const base = require('./m9d860Env');
const budgets = require('../../../src/features/core-governance/finops/budgets/budget.service');
const { OutboxEvent, Notification } = require('../../../src/models');

const { sequelize } = base;
const dayKeyOf = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const TODAY = dayKeyOf(new Date());
/** Primeiro dia do mês anterior ao de hoje (AAAA-MM-DD). */
const PREV_MONTH_DAY = (() => { const [y, m] = TODAY.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 10)).toISOString().slice(0, 10); })();

/**
 * Isola o teste do resto que outros arquivos deixaram no mesmo banco: dentro da transação do teste (reverte no rollback) remove os orçamentos,
 * alertas e o custo lançado do grupo, para que o escopo único e o consumo sejam só os do próprio teste.
 */
async function isolate(tenant, tx) {
  const g = { g: tenant.groupId };
  await sequelize.query('DELETE FROM governance.budget_alerts WHERE budget_id IN (SELECT id FROM governance.budgets WHERE group_id = :g)', { transaction: tx, replacements: g });
  await sequelize.query('DELETE FROM governance.budgets WHERE group_id = :g', { transaction: tx, replacements: g });
  await sequelize.query('DELETE FROM governance.cost_read_model WHERE group_id = :g', { transaction: tx, replacements: g });
  await sequelize.query('DELETE FROM governance.cost_ledger WHERE group_id = :g', { transaction: tx, replacements: g });
}

const mkBudget = (tenant, tx, over = {}) => budgets.createBudget(tenant, { environment: 'PROD', domain: 'PLATFORM', amountCents: 300000, ownerUserId: tenant.userId, ...over }, tenant.userId, tx);
const spend = (tenant, tx, cents, over = {}) => base.record(tenant, [base.dayLine(tenant, over.day || TODAY, { service: base.uniq(), amountCents: cents, ...over })], tx);
const alertsOf = (budgetId, tx) => sequelize.query('SELECT threshold, percent, series, period_start::text AS period_start, consumed_cents FROM governance.budget_alerts WHERE budget_id = :budgetId ORDER BY seq', { type: QueryTypes.SELECT, transaction: tx, replacements: { budgetId } });
const eventsOf = (budgetId, tx) => OutboxEvent.findAll({ where: { aggregateId: budgetId, eventType: 'finops.budget.threshold' }, transaction: tx });
const noticesOf = (userId, tx) => Notification.findAll({ where: { userId }, transaction: tx });

module.exports = { ...base, TODAY, PREV_MONTH_DAY, isolate, mkBudget, spend, alertsOf, eventsOf, noticesOf, budgets };
