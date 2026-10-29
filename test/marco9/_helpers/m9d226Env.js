'use strict';

// Apoio dos testes da contingência (M9-D226): conexões ativas com política, estado da contingência, eventos, tarefas e ciclo do worker. Roda em banco descartável.
const e214 = require('./m9d214Env');
const e217 = require('./m9d217Env');
const { OutboxEvent } = require('../../../src/models');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const contingency = require('../../../src/features/integrations/contingency');
const { criar, chave } = require('../../integrations/dispatch/dispatchHelpers');

const { sequelize, comTenant, ctxDe } = e214;
const CHAVES = ['integration.contingency.recovery_checks', 'integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE', 'integration.contingency.queue_max_age_h.QUEUE_QUERY_OR_ALTERNATE_PROVIDER',
  'integration.bank.max_pending_hours', 'integration.contingency.drain_batch_size', 'integration.contingency.manual_task_assignee_role', 'integration.rate_limit.reserve_pct'];

/** Cria a conexão do fornecedor (ambiente do servidor de teste), com a política dada, e a deixa ACTIVE (desativando a ativa do mesmo fornecedor). */
async function conexaoDe(tenant, providerCode, { contingencia, policy } = {}) {
  const policyJson = policy || (contingencia ? { contingency: contingencia } : {});
  const c = await comTenant(tenant, (t) => registry.createConnection({ providerCode, environment: 'SANDBOX', label: `QA-M9 ${e214.uniqueSuffix()}`, policyJson }, ctxDe(tenant), t));
  await comTenant(tenant, async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE' AND id <> :id", { replacements: { c: tenant.companyId, p: providerCode, id: c.id }, transaction: t });
    await transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t);
  });
  return c;
}

const definirPolitica = (tenant, id, contingencia) => comTenant(tenant, (t) => registry.updateConnection(id, { policyJson: { contingency: contingencia } }, ctxDe(tenant), t));

const ativas = (tenant) => comTenant(tenant, (t) => contingency.listActiveContingencies(ctxDe(tenant), t));
const ciclo = (tenant, now = new Date()) => comTenant(tenant, (t) => contingency.runContingencyCycle(ctxDe(tenant), { now }, t));

/** Encerra (SQL) as contingências abertas da empresa: o estado de um teste não vaza para o seguinte. */
const limparContingencias = (tenant) => comTenant(tenant, (t) => sequelize.query(
  "UPDATE integration.integration_errors SET status = 'RESOLVED', resolved_at = now(), resolution_note = 'limpeza de teste' WHERE company_id = :c AND error_code = 'CONTINGENCY_ACTIVE' AND status = 'OPEN'", { replacements: { c: tenant.companyId }, transaction: t },
));

const eventos = (tenant, tipo) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM integration.outbox_events WHERE company_id = :c AND event_type = :tipo ORDER BY created_at', { replacements: { c: tenant.companyId, tipo }, transaction: t },
))[0]);

/** Roda os consumidores dos eventos (como o despachante do outbox) e devolve quantos processou. */
async function consumir(tenant, tipo) {
  return comTenant(tenant, async (t) => {
    const rows = await OutboxEvent.findAll({ where: { companyId: tenant.companyId, eventType: tipo }, transaction: t });
    for (const e of rows) await runEventConsumers(e, t);
    return rows.length;
  });
}

const tarefasDoEnvio = (tenant, dispatchId) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM core.tasks WHERE company_id = :c AND related_entity_id = :id', { replacements: { c: tenant.companyId, id: dispatchId }, transaction: t },
))[0]);

/** Tira de cena as conexões ativas ou paradas de uma família (a família fica sem connection ativa). */
const semConexoes = (tenant, domain) => comTenant(tenant, (t) => sequelize.query(
  `UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND status IN ('ACTIVE', 'PAUSED', 'AUTH_FAILED')
     AND provider_code IN (SELECT code FROM integration.providers WHERE domain = :d)`, { replacements: { c: tenant.companyId, d: domain }, transaction: t },
));

/** Registra `n` testes de saúde seguidos (ok ou falha) da connection. */
async function checks(tenant, connectionId, n, ok = true) {
  for (let i = 0; i < n; i += 1) await comTenant(tenant, (t) => e217.health.recordHealthCheck(connectionId, { ok, latencyMs: 5 }, t));
}

const fecharCircuito = (tenant, id) => e217.forcarCircuito(tenant, id, { circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null, consecutiveFailures: 0 });
const envelhecer = (tenant, dispatchId, horas) => e214.forcar(tenant, dispatchId, `created_at = now() - interval '${Number(horas)} hours'`);

module.exports = {
  ...e214, ...e217, contingency, criar, chave, conexaoDe, definirPolitica, ativas, ciclo, limparContingencias, eventos, consumir, tarefasDoEnvio, semConexoes, checks, fecharCircuito, envelhecer, CHAVES, registry,
};
