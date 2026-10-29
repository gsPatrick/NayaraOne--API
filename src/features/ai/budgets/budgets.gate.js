'use strict';

const repo = require('../readmodels/budgetSupport.readmodel');
const E = require('./budgets.errors');
const { readBudgetParams } = require('./budgets.params');
const { budgetPolicy } = require('./budgets.policy');
const { reaches, toMicro, normalize } = require('./budgets.money');
const { raiseAlerts } = require('./budgets.alerts');
const { pickGoverning, ensureCurrentPeriod, agentCriticality } = require('./budgets.resolve');
const { ROUTING_PATHS, PAID_PATHS, CLASS_BY_PATH, CRITICALITY } = require('./budgets.constants');

const SMALL_PATHS = ['SMALL_MODEL', 'EMBEDDING'];

/**
 * Portão de orçamento antes de gastar (M9-D014). Na transação do chamador:
 *  - RULE: custo zero, sempre passa (mesmo sem orçamento);
 *  - sem orçamento ATIVO que contenha o escopo: 403 AI_BUDGET_NOT_CONFIGURED (falha fechada);
 *  - a política (budgets.policy) decide, pelo orçamento mais específico, quais caminhos valem; fora deles, 429 AI_BUDGET_EXHAUSTED;
 *  - caminho pago: reserva atômica da estimativa em TODOS os orçamentos que contêm o escopo, sob FOR UPDATE; passando do limite
 *    em algum, 429. Agente CRITICAL acima do limite só reserva sem condição em modelo pequeno (o "fallback definido").
 * Devolve a reserva (`free` quando não há custo a reservar), que settle() troca pelo custo real e release() devolve.
 */
async function reserve(ctx, input, transaction) {
  const path = input.routingPath;
  if (!ROUTING_PATHS.includes(path)) throw E.invalid('Caminho de roteamento inválido.', { routingPath: path });
  if (path === 'RULE') return { free: true, state: 'NORMAL', routingPath: path, budgetIds: [], estimate: '0.000000' };
  const at = input.at || new Date();
  const agentCode = input.agentCode ? String(input.agentCode).toUpperCase() : null;
  const params = await readBudgetParams(ctx, transaction);
  await ensureCurrentPeriod(ctx, at, transaction);
  const budgets = await repo.lockApplicable(ctx, { agentCode, modelClass: CLASS_BY_PATH[path], at }, transaction);
  if (!budgets.length) throw E.notConfigured();
  const governing = pickGoverning(budgets);
  const criticality = input.criticality || (await agentCriticality(ctx, agentCode, transaction));
  const policy = budgetPolicy({
    reached: (pct) => reaches(governing.consumedAmount, governing.limitAmount, pct),
    criticality, actionAt100: governing.actionAt100 || params.actionAt100, degradeFrom: params.degradeFrom,
  });
  const details = { state: policy.state, routingPath: path, budgetId: governing.id };
  if (!policy.allowedPaths.includes(path)) throw policy.state === 'DEGRADED' ? E.degraded(details) : E.exhausted(details);
  const base = { free: true, state: policy.state, routingPath: path, budgetIds: [], governingId: governing.id, estimate: '0.000000' };
  if (!PAID_PATHS.includes(path)) return base;

  const estimate = String(input.estimate ?? '0');
  if (toMicro(estimate) < 0n) throw E.invalid('A estimativa de custo não pode ser negativa.');
  const ids = budgets.map((b) => b.id);
  const over = await repo.overLimit(ids, estimate, transaction);
  const criticalFallback = criticality === CRITICALITY.CRITICAL && SMALL_PATHS.includes(path);
  if (over.length && !criticalFallback) throw E.exhausted({ ...details, budgetId: over[0].id, reason: 'ESTIMATE_OVER_LIMIT' });
  const reserved = await repo.addReservation(ids, estimate, over.length === 0, transaction);
  if (reserved.length !== ids.length) throw E.exhausted({ ...details, reason: 'RESERVATION_RACE' });
  return { free: false, state: policy.state, routingPath: path, budgetIds: ids, governingId: governing.id, estimate: normalize(estimate) };
}

/** Troca a reserva pelo custo real e dispara os alertas dos limiares alcançados. */
async function settle(ctx, reservation, actualCost, transaction) {
  if (!reservation || reservation.free) return { raised: [] };
  const actual = normalize(actualCost ?? '0');
  const rows = await repo.swapReservation(reservation.budgetIds, reservation.estimate, actual, transaction);
  const params = await readBudgetParams(ctx, transaction);
  const raised = [];
  for (const row of rows) {
    for (const threshold of await raiseAlerts(ctx, row, params.thresholds, transaction)) raised.push({ budgetId: row.id, threshold });
  }
  return { raised };
}

/** Falha no meio: devolve a reserva sem consumir nada. */
async function release(ctx, reservation, transaction) {
  if (!reservation || reservation.free) return;
  await repo.swapReservation(reservation.budgetIds, reservation.estimate, '0.000000', transaction);
}

/** reserve -> call(reservation) -> settle(custo real); se call falhar, release e o erro sobe. call devolve { cost, ... }. */
async function spendWithBudget(ctx, input, call, transaction) {
  const reservation = await reserve(ctx, input, transaction);
  let outcome;
  try {
    outcome = await call(reservation);
  } catch (err) {
    await release(ctx, reservation, transaction);
    throw err;
  }
  const { raised } = await settle(ctx, reservation, outcome && outcome.cost, transaction);
  return { ...outcome, reservation, alertsRaised: raised };
}

module.exports = { reserve, settle, release, spendWithBudget };
