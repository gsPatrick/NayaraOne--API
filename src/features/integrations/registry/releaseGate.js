'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { ctxOk } = require('./registry.helpers');
const { assessProductionReadiness } = require('../health/productionReadiness');
require('../health/alerts/alerts.readiness'); // registra a verificação "alerts" (M9-D224)
const { effectiveCriticality } = require('../providers/catalog.service');
const { readReleaseParams } = require('./release.params');
const { EVIDENCE_ITEMS, STATES, EVIDENCE_MISSING, EVIDENCE_MESSAGE } = require('./release.constants');
const { contractProblem } = require('./release.evidence.contract');
const { drillProblem } = require('./release.evidence.drill');
const { secretProblems } = require('./release.evidence.secret');
const { healthLabProblem, egressProblem, contingencyProblem } = require('./release.evidence.operation');

/** Estado do portão de uma connection: liberada em produção e não pausada nem desativada (voltar a não liberada é pelo status, M9-D200). */
const releaseStateOf = (c) => (c.productionReleasedAt && !['PAUSED', 'DISABLED'].includes(c.status) ? STATES.RELEASED : STATES.NOT_RELEASED);

const READINESS_CODES = Object.freeze({
  healthCheck: ['INTEGRATION_RELEASE_HEALTHCHECK_MISSING', 'O fornecedor não tem teste de saúde implementado.'],
  runbook: ['INTEGRATION_RELEASE_RUNBOOK_MISSING', 'Falta o runbook completo deste fornecedor.'],
  slo: ['INTEGRATION_RELEASE_SLO_MISSING', 'Falta o SLO definido para a criticidade deste fornecedor.'],
  alerts: ['INTEGRATION_RELEASE_ALERTS_MISSING', 'Faltam os alertas configurados para esta integração.'],
});

async function loadProvider(providerCode, transaction) {
  const provider = await IntegrationProvider.findByPk(providerCode, { transaction });
  if (!provider) throw AppError.unprocessable('Fornecedor não cadastrado no catálogo de integrações.', 'INTEGRATION_PROVIDER_UNKNOWN');
  return provider;
}

/**
 * Avalia as evidências 1 a 8 (verificadas por máquina; a 9, aprovação humana com MFA, é do serviço de liberação) de uma connection. Usa o
 * assessProductionReadiness (M9-D223) para saúde, runbook, SLO e alertas; a verificação `contractTests` dele é registrada aqui (release.evidence.contract).
 * Devolve { connectionId, providerCode, releaseState, ready, items, missing: [{ item, code, message, detail }] } na ordem do livro.
 */
async function evaluateConnection(connection, ctx, transaction) {
  const provider = await loadProvider(connection.providerCode, transaction);
  const params = await readReleaseParams(ctx, transaction);
  const semConta = params.noExternalAccountProviders.includes(connection.providerCode);
  const readiness = await assessProductionReadiness(connection.providerCode, ctx, transaction);
  const problemas = {
    contractLive: await contractProblem(connection.providerCode, { live: true, apiVersion: connection.apiVersion }, ctx, transaction),
    contractTests: await contractProblem(connection.providerCode, { live: false, apiVersion: connection.apiVersion }, ctx, transaction),
    failureDrill: drillProblem(connection.providerCode, params.drillScenarios),
    healthLab: await healthLabProblem(connection, transaction),
    egress: semConta ? null : egressProblem(connection),
    contingency: await contingencyProblem(connection, provider, ctx, transaction),
  };
  Object.entries(READINESS_CODES).forEach(([item, [code, message]]) => { problemas[item] = readiness.items[item].ok ? null : { code, message, detail: readiness.items[item].detail }; });
  if (semConta) Object.assign(problemas, { secret: null, webhookSecret: null });
  else Object.assign(problemas, await secretProblems(connection, ctx, params, transaction));
  const missing = EVIDENCE_ITEMS.filter((item) => problemas[item]).map((item) => ({ item, code: problemas[item].code, message: problemas[item].message, detail: problemas[item].detail === undefined ? null : problemas[item].detail }));
  const items = Object.fromEntries(EVIDENCE_ITEMS.map((item) => [item, { ok: !problemas[item] }]));
  return { connectionId: connection.id, providerCode: connection.providerCode, releaseState: releaseStateOf(connection), ready: missing.length === 0, items, missing };
}

/** releaseGate.evaluate(connectionId): o relatório das evidências de uma connection da empresa. Não muda nada. */
async function evaluate(connectionId, ctx, transaction) {
  ctxOk(ctx);
  const c = await IntegrationConnection.findOne({ where: { id: String(connectionId), companyId: ctx.companyId }, transaction });
  if (!c) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  return evaluateConnection(c, ctx, transaction);
}

const evidenceMissing = (missing) => AppError.conflict(EVIDENCE_MESSAGE, EVIDENCE_MISSING, { missing });

/** Estado do portão por fornecedor do catálogo e por connection de PRODUÇÃO da empresa (a página de entrega mostra isto, sem declarar produção sem liberação). */
async function listReleaseStates(ctx, transaction) {
  ctxOk(ctx);
  const providers = await IntegrationProvider.findAll({ order: [['code', 'ASC']], transaction });
  const conexoes = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, environment: 'PRODUCTION' }, order: [['providerCode', 'ASC'], ['label', 'ASC']], transaction });
  const connections = conexoes.map((c) => ({
    connectionId: c.id, providerCode: c.providerCode, label: c.label, status: c.status, releaseState: releaseStateOf(c), productionReleasedAt: c.productionReleasedAt,
  }));
  const linhas = [];
  for (const p of providers) {
    const dele = connections.filter((c) => c.providerCode === p.code);
    const liberadas = dele.filter((c) => c.releaseState === STATES.RELEASED).length;
    linhas.push({
      providerCode: p.code, displayName: p.displayName, domain: p.domain, criticality: await effectiveCriticality(p.domain, ctx, transaction),
      releaseState: liberadas ? STATES.RELEASED : STATES.NOT_RELEASED, released: liberadas, connections: dele.length,
    });
  }
  const released = connections.filter((c) => c.releaseState === STATES.RELEASED).length;
  return {
    providers: linhas, connections,
    summary: { providers: linhas.length, releasedProviders: linhas.filter((p) => p.releaseState === STATES.RELEASED).length, released, notReleased: connections.length - released },
  };
}

module.exports = { evaluate, evaluateConnection, listReleaseStates, releaseStateOf, evidenceMissing };
