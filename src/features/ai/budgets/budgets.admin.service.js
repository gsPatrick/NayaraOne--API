'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('../readmodels/budgetSupport.readmodel');
const E = require('./budgets.errors');
const V = require('./budgets.validation');
const { readBudgetParams } = require('./budgets.params');
const { toBudget, auditSnapshot } = require('./budgets.mapper');
const { ensureCurrentPeriod } = require('./budgets.resolve');
const { monthPeriodOf } = require('./budgets.period');
const { toMicro } = require('./budgets.money');
const agentsRepo = require('../agents/agents.repository');

async function audit(ctx, action, before, after, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action, entityType: 'AiBudget', entityId: after.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' }, afterJson: auditSnapshot(after), reason,
  }, transaction);
}

/** GET /v1/ai/budgets: os orçamentos do mês corrente com consumo, percentual e alertas. */
async function listBudgets(ctx, transaction, { at = new Date() } = {}) {
  await ensureCurrentPeriod(ctx, at, transaction);
  const rows = await repo.listForPeriod(ctx, at, transaction);
  const params = await readBudgetParams(ctx, transaction);
  const alerts = await repo.listAlerts(ctx, rows.map((r) => r.id), transaction);
  return rows.map((r) => toBudget(r, params, alerts.filter((a) => a.budgetId === r.id)));
}

/**
 * POST /v1/ai/budgets: cria a linha do mês corrente para um escopo. O livro não diz como nasce o primeiro orçamento (DI-D014-1):
 * é criado aqui por quem tem ai:budget; os meses seguintes são copiados sozinhos.
 */
async function createBudget(ctx, body, transaction, { at = new Date() } = {}) {
  const d = V.parseCreate(body);
  if (d.agentCode && !(await agentsRepo.listByCode(ctx, d.agentCode, transaction)).length) throw E.invalid('Agente desconhecido.', { field: 'agentCode' });
  const period = monthPeriodOf(at);
  await ensureCurrentPeriod(ctx, at, transaction);
  const exists = (await repo.listForPeriod(ctx, at, transaction)).some((r) => r.agentCode === d.agentCode && r.modelClass === d.modelClass);
  if (exists) throw E.duplicate();
  const row = await repo.insertBudget(ctx, { ...d, period }, transaction);
  await audit(ctx, 'ai.budget.created', null, row, 'Orçamento de IA criado.', transaction);
  return toBudget(row, await readBudgetParams(ctx, transaction));
}

/** PUT /v1/ai/budgets/:id: limite, limiares, ação ao chegar em 100% e status. Limite menor que o consumido: 400. Auditoria antes/depois. */
async function updateBudget(ctx, id, body, transaction) {
  if (!V.isUuid(id)) throw E.notFound();
  const d = V.parseUpdate(body);
  const before = await repo.findById(ctx, id, transaction, { lock: true });
  if (!before) throw E.notFound();
  if (d.limitAmount !== undefined && toMicro(d.limitAmount) < toMicro(before.consumedAmount)) {
    throw E.belowConsumed({ consumedAmount: before.consumedAmount, limitAmount: d.limitAmount });
  }
  const next = {
    limitAmount: d.limitAmount ?? before.limitAmount,
    thresholds: d.thresholds === undefined ? before.thresholds : d.thresholds,
    actionAt100: d.actionAt100 === undefined ? before.actionAt100 : d.actionAt100,
    status: d.status ?? before.status,
  };
  const row = await repo.updateBudget(ctx, id, next, transaction);
  await audit(ctx, 'ai.budget.updated', before, row, 'Orçamento de IA alterado.', transaction);
  return toBudget(row, await readBudgetParams(ctx, transaction));
}

module.exports = { listBudgets, createBudget, updateBudget };
