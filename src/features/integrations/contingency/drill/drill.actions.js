'use strict';

const { Group, Company, IntegrationConnection, IntegrationProvider, OutboxEvent } = require('../../../../models');
const { sequelize } = require('../../../../models');
const registry = require('../../registry/registry.service');
const { transitionConnection } = require('../../registry/connections.transition');
const { tenantTx } = require('../../dispatch/worker/tenantTx');
const { createDrillDispatch } = require('../../dispatch/dispatch.drillItem');
const { runEventConsumers } = require('../../../../engines/events/consumers');
const { PORTS } = require('../../providers/ports');
const { recordCallResult } = require('../../health/circuitBreaker');
const { recordHealthCheck } = require('../../health/healthRecorder');
const { updateCircuitState } = require('../../health/circuitState');
const { resolveCircuitPolicy } = require('../../health/circuitPolicyReader');
const { runContingencyCycle } = require('../contingency.cycle');
const { listActiveContingencies } = require('../contingency.list');
const { resolveContingencyPolicy } = require('../contingency.policy');
const { EVENTS } = require('../contingency.constants');

/** Empresa do ensaio: a informada ou a primeira empresa do primeiro grupo. Devolve { groupId, companyId }. */
async function pickCompany(companyId) {
  const grupos = await Group.findAll({ order: [['created_at', 'ASC']] });
  for (const g of grupos) {
    const empresa = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: g.id }, transaction: t });
      return Company.findOne({ where: companyId ? { id: companyId } : {}, order: [['created_at', 'ASC']], transaction: t });
    });
    if (empresa) return { groupId: g.id, companyId: empresa.id };
  }
  return null;
}

/** O fornecedor do ensaio precisa ser de laboratório (sandbox_available) ou o fluxo manual: nunca um fornecedor real. */
async function loadSandboxProvider(code) {
  const p = await IntegrationProvider.findByPk(code);
  return p && (p.sandboxAvailable === true || p.code === 'financing-manual') ? p : null;
}

const withCtx = (ctx, fn) => tenantTx(ctx, (t) => fn(t));

async function createDrillConnection(ctx, provider) {
  return withCtx(ctx, async (t) => {
    const ativa = await IntegrationConnection.findOne({ where: { companyId: ctx.companyId, providerCode: provider.code, status: 'ACTIVE' }, transaction: t });
    if (ativa) return { existing: true };
    const c = await registry.createConnection({ providerCode: provider.code, environment: registry.getServerEnvironment(), label: `ENSAIO ${Date.now()}` }, ctx, t);
    await transitionConnection(c.id, 'ACTIVE', ctx, t);
    return { connection: c };
  });
}

/** "Derruba o sandbox": falhas reais do fornecedor até o circuito abrir (a contingência é acionada pelo próprio circuito). */
async function failUntilCircuitOpens(ctx, connectionId, errorClass = 'TRANSIENT') {
  return withCtx(ctx, async (t) => {
    const c = await IntegrationConnection.findByPk(connectionId, { transaction: t });
    const { failure_threshold: limite } = await resolveCircuitPolicy(ctx, c, t);
    let abriu = false;
    for (let i = 0; i < limite && !abriu; i += 1) abriu = (await recordCallResult(c, ctx, t, { ok: false, errorClass })).opened;
    return { opened: abriu, failures: limite };
  });
}

/** Põe um envio na fila da connection (primeira operação do port) e o deixa "velho", além da idade máxima do modo. */
async function queueAgedItem(ctx, connection, now) {
  return withCtx(ctx, async (t) => {
    const policy = await resolveContingencyPolicy(ctx, connection, t);
    const provider = await IntegrationProvider.findByPk(connection.providerCode, { transaction: t });
    const operacoes = PORTS[provider.domain].operations;
    const operation = Object.keys(operacoes).find((o) => operacoes[o].opClass === 'SAFE') || Object.keys(operacoes)[0];
    const dispatch = await createDrillDispatch(ctx, connection, operation, t);
    const horas = (policy && policy.queueMaxAgeH ? policy.queueMaxAgeH : 24) + 1;
    await sequelize.query('UPDATE integration.dispatches SET created_at = :quando WHERE id = :id', { replacements: { quando: new Date(now.getTime() - horas * 3600000), id: dispatch.id }, transaction: t });
    return { dispatchId: dispatch.id, ageHours: horas };
  });
}

const runCycle = (ctx, now) => withCtx(ctx, (t) => runContingencyCycle(ctx, { now }, t));
const activeOf = (ctx) => withCtx(ctx, (t) => listActiveContingencies(ctx, t));

/** Consome o evento da tarefa manual (como o despachante do outbox) e devolve as tarefas criadas para o envio. */
async function consumeManualTask(ctx, dispatchId) {
  return withCtx(ctx, async (t) => {
    const eventos = await OutboxEvent.findAll({ where: { companyId: ctx.companyId, eventType: EVENTS.MANUAL_TASK, aggregateId: dispatchId }, transaction: t });
    for (const e of eventos) await runEventConsumers(e, t);
    const [tarefas] = await sequelize.query('SELECT id, status FROM core.tasks WHERE company_id = :c AND related_entity_id = :id', { replacements: { c: ctx.companyId, id: dispatchId }, transaction: t });
    return { events: eventos.length, tasks: tarefas.length };
  });
}

/** Rajada de 429 do fornecedor: limite de uso não é falha do fornecedor, então o circuito NÃO pode abrir. Devolve o estado do circuito depois. */
async function rateLimitStorm(ctx, connectionId) {
  return withCtx(ctx, async (t) => {
    const c = await IntegrationConnection.findByPk(connectionId, { transaction: t });
    const { failure_threshold: limite } = await resolveCircuitPolicy(ctx, c, t);
    let abriu = false;
    for (let i = 0; i < limite + 1; i += 1) abriu = (await recordCallResult(c, ctx, t, { ok: false, errorClass: 'RATE_LIMIT' })).opened || abriu;
    return { opened: abriu, calls: limite + 1 };
  });
}

const closeCircuit = (ctx, connectionId) => withCtx(ctx, (t) => updateCircuitState(connectionId, { circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null, consecutiveFailures: 0 }, t));
const okChecks = (ctx, connectionId, n) => withCtx(ctx, async (t) => { for (let i = 0; i < n; i += 1) await recordHealthCheck(connectionId, { ok: true, latencyMs: 5 }, t); });
const dispatchStatus = (ctx, id) => withCtx(ctx, async (t) => (await sequelize.query('SELECT status, next_attempt_at FROM integration.dispatches WHERE id = :id', { replacements: { id }, transaction: t }))[0][0]);

/** Limpeza do ensaio: cancela o envio de laboratório e desativa a connection de laboratório. */
async function cleanup(ctx, connectionIds, dispatchIds) {
  await withCtx(ctx, async (t) => {
    if (dispatchIds.length) await sequelize.query("UPDATE integration.dispatches SET status = 'CANCELLED' WHERE company_id = :c AND id IN (:ids) AND status IN ('PENDING','RETRY_WAIT')", { replacements: { c: ctx.companyId, ids: dispatchIds }, transaction: t });
    if (connectionIds.length) await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND id IN (:ids)", { replacements: { c: ctx.companyId, ids: connectionIds }, transaction: t });
  });
}

module.exports = {
  pickCompany, loadSandboxProvider, rateLimitStorm, createDrillConnection, failUntilCircuitOpens, queueAgedItem, runCycle, activeOf, consumeManualTask, closeCircuit, okChecks, dispatchStatus, cleanup, withCtx,
};
