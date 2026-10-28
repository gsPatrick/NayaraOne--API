'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const { LIMIT_SPECS } = require('./agents.constants');

/**
 * Limites efetivos de um agente: o valor da versão (coluna `limits`) vence o parâmetro da empresa `ia.agente.*`, que é o
 * padrão das versões que não definem o limite. Resultado em camelCase: maxToolCallsPorRun, maxRunsPorMinutoUsuario,
 * timeoutMs, maxTokensRun.
 */
async function resolveLimits(agent, ctx, transaction) {
  const out = {};
  for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
    const own = agent.limits && agent.limits[key];
    if (Number.isInteger(own)) {
      out[spec.field] = own;
    } else {
      const configured = await getSetting(spec.setting, ctx, transaction, spec.fallback);
      out[spec.field] = Number.isInteger(configured) && configured >= spec.min ? configured : spec.fallback;
    }
  }
  return out;
}

module.exports = { resolveLimits };
