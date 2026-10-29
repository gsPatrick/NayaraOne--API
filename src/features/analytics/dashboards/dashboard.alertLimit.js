'use strict';

/**
 * M9-D626 (3.1 item 8) — limiar do alerta de um cartão. O cartão acende o alerta quando o número passa do limiar do ALERTA PUBLICADO para o indicador
 * (alerta de limite simples, da empresa ou do grupo, sem recorte por dimensão). Sem alerta publicado, vale o parâmetro do administrador
 * (`config.alertLimit.settingKey`, operador "maior que"). Decidido aqui, no servidor: o Front só acende o aviso.
 */
const readStore = require('../dashboardReadStore.service');
const { readPanelSetting } = require('../panelSettings');

const TESTS = Object.freeze({
  GT: (a, b) => a > b, GTE: (a, b) => a >= b, LT: (a, b) => a < b, LTE: (a, b) => a <= b, EQ: (a, b) => a === b, NEQ: (a, b) => a !== b,
});

/** { operator, value, source: 'ALERTA_PUBLICADO' | 'PARAMETRO' } do indicador. */
async function resolveAlertLimit(ctx, metricCode, spec, transaction) {
  const published = await readStore.findPublishedAlertThreshold({ metricCode, companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
  if (published && TESTS[published.operator] && Number.isFinite(Number(published.value))) return { operator: published.operator, value: Number(published.value), source: 'ALERTA_PUBLICADO' };
  return { operator: 'GT', value: await readPanelSetting(spec.settingKey, ctx, transaction), source: 'PARAMETRO' };
}

/** true quando o valor (texto decimal do snapshot) passa do limiar; valor nulo nunca acende. */
function passesLimit(rawValue, limit) {
  if (rawValue === null || rawValue === undefined || !limit) return false;
  return TESTS[limit.operator](Number(rawValue), limit.value);
}

module.exports = { resolveAlertLimit, passesLimit };
