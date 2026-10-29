'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { getServerEnvironment } = require('../../registry/registry.helpers');
const { getCurrentHealth } = require('../../health/healthQuery');
const { registerContingencyHandler } = require('../contingency.registry');

/**
 * IA fora aciona o modo determinístico (M9-D243 3.2 b; livro, seção 18: "IA fora: funções determinísticas continuam; IA degrada").
 * O provider de modelo é uma integração como as outras: sem connection ativa, com o circuito aberto ou com a saúde em DOWN a IA está fora e
 * toda função com IA usa o caminho determinístico equivalente (busca por palavras no lugar da semântica, texto pré-definido no lugar de
 * redação, regra no lugar de recomendação). A falta da IA nunca impede o ERP (INT-012). A política completa por família é da M9-D228.
 */
const MODE = Object.freeze({ NORMAL: 'NORMAL', DEGRADED: 'DEGRADE_TO_DETERMINISTIC' });
const UNAVAILABLE_CODES = Object.freeze(['UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', 'AI_PROVIDER_UNAVAILABLE', 'AI_RUN_TIMEOUT']);

let contingencyCount = 0;
const getAiContingencyCount = () => contingencyCount;

const degraded = (reason) => ({ mode: MODE.DEGRADED, degraded: true, reason });

/** O modo atual da IA para a empresa: NORMAL se algum provider de modelo ativo está de pé; senão DEGRADE_TO_DETERMINISTIC com o motivo. */
async function resolveAiMode(ctx, transaction) {
  const providers = await IntegrationProvider.findAll({ where: { domain: 'AI' }, attributes: ['code'], transaction });
  const connections = await IntegrationConnection.findAll({
    where: { companyId: ctx.companyId, environment: getServerEnvironment(), status: 'ACTIVE', providerCode: providers.map((p) => p.code) }, transaction,
  });
  if (connections.length === 0) return degraded('NO_ACTIVE_CONNECTION');
  const saude = [];
  for (const c of connections) saude.push(await getCurrentHealth(c.id, ctx, transaction));
  if (saude.some((h) => h.circuitState !== 'OPEN' && h.healthStatus !== 'DOWN')) return { mode: MODE.NORMAL, degraded: false, reason: null };
  return degraded(saude.some((h) => h.circuitState === 'OPEN') ? 'CIRCUIT_OPEN' : 'HEALTH_DOWN');
}

const isAiUnavailable = (err) => Boolean(err) && (UNAVAILABLE_CODES.includes(err.code) || UNAVAILABLE_CODES.includes(err.errorCode));

/**
 * withAiFallback(ctx, { ai, deterministic }, transaction) — roda `ai()` quando a IA está de pé e `deterministic()` quando ela está fora ou cai
 * na hora da chamada. Devolve { mode, reason, result }. Erro que não é queda da IA (um defeito) continua sendo erro.
 */
async function withAiFallback(ctx, { ai, deterministic }, transaction) {
  const atual = await resolveAiMode(ctx, transaction);
  if (atual.degraded) return { mode: atual.mode, reason: atual.reason, result: await deterministic() };
  try {
    return { mode: MODE.NORMAL, reason: null, result: await ai() };
  } catch (err) {
    if (!isAiUnavailable(err)) throw err;
    logger.warn({ code: err.code, companyId: ctx.companyId }, 'IA indisponível na chamada: seguindo pelo caminho determinístico');
    return { mode: MODE.DEGRADED, reason: 'AI_UNAVAILABLE', result: await deterministic() };
  }
}

/** Gancho de contingência da família AI (M9-D201 regra 3): sem connection ativa o 404 sai e o modo determinístico fica registrado em log. */
function registerAiContingency() {
  registerContingencyHandler('AI', async ({ companyId }) => {
    contingencyCount += 1;
    logger.warn({ companyId, mode: MODE.DEGRADED }, 'Provider de IA indisponível: funções com IA usam o caminho determinístico');
  });
}

module.exports = { MODE, resolveAiMode, withAiFallback, isAiUnavailable, registerAiContingency, getAiContingencyCount };
