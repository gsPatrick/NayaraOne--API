'use strict';

const adapterRegistry = require('../registry/adapterRegistry');
const { IntegrationProvider } = require('../../../models');
const { effectiveCriticality } = require('../providers/catalog.service');
const { readHealthParams } = require('./healthParams');
const { assertRunbook } = require('./runbooks');

/**
 * Completude para liberar um fornecedor em produção (M9-D223 regra 3.3): só pode virar `production_released` (M9-D256) quem tem
 * (1) health check implementado, (2) contract tests verdes, (3) runbook completo, (4) alertas configurados e (5) SLO definido.
 * Os três primeiros que esta área sabe verificar sozinha são o health check (o adapter registrado cumpre o contrato do boot, que
 * exige `healthCheck`), o runbook e o SLO da criticidade; os alertas (M9-D224) e os contract tests (M9-D256) registram a sua
 * verificação por `registerReadinessCheck`. Item sem verificação registrada NÃO conta como cumprido.
 */
const extras = new Map();
const registerReadinessCheck = (name, fn) => { extras.set(name, fn); };
const clearReadinessChecks = () => extras.clear();

const ok = (detail = 'ok') => ({ ok: true, detail });
const falta = (detail) => ({ ok: false, detail });

async function builtIn(providerCode, ctx, transaction) {
  const healthCheck = adapterRegistry.has(providerCode) ? ok('adapter registrado com healthCheck do contrato') : falta('sem adapter registrado para o fornecedor');
  let runbook;
  try { runbook = ok(assertRunbook(providerCode)); } catch (err) { runbook = falta((err.details && err.details.problemas || [err.message]).join('; ')); }
  const provider = await IntegrationProvider.findByPk(providerCode, { transaction });
  let slo = falta('fornecedor fora do catálogo');
  if (provider) {
    const criticidade = await effectiveCriticality(provider.domain, ctx, transaction);
    const params = await readHealthParams(ctx, transaction);
    slo = params.slo[criticidade] && params.slo[criticidade].minSuccessRate > 0 ? ok(`meta da criticidade ${criticidade}`) : falta(`sem SLO para a criticidade ${criticidade}`);
  }
  return { healthCheck, runbook, slo };
}

/** { ready, items: { healthCheck, runbook, slo, alerts, contractTests }, missing: [nomes] }. */
async function assessProductionReadiness(providerCode, ctx, transaction) {
  const items = await builtIn(providerCode, ctx, transaction);
  for (const nome of ['alerts', 'contractTests']) {
    const check = extras.get(nome);
    let r = falta('verificação ainda não registrada');
    if (check) {
      try { r = await check(providerCode, ctx, transaction); } catch (err) { r = falta('a verificação falhou'); }
    }
    items[nome] = r;
  }
  const missing = Object.entries(items).filter(([, v]) => !v.ok).map(([k]) => k);
  return { ready: missing.length === 0, items, missing };
}

module.exports = { assessProductionReadiness, registerReadinessCheck, clearReadinessChecks };
