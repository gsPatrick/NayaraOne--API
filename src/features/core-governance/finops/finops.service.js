'use strict';

const { isModuleEnabled } = require('../governance.module');
const { readFinopsParams } = require('./finops.params');
const readModel = require('./costReadModel');
const { collectorStatus } = require('./collectors/status');
const { listViews } = require('./budgets/budget.view');

/**
 * FinOps — serviço do módulo. M9-D860: o custo técnico sai em DUAS séries separadas, `estimado` e `faturado`, cada uma com o seu total; nenhuma resposta
 * traz total que some as duas. O custo compartilhado (sem empresa) só aparece para quem administra o FinOps. Orçamentos e alertas: M9-D861 (`orcamentos`, com as duas séries lado a lado); detectores: M9-D862.
 */
async function getOverview(tenant, transaction, { includeShared = false, now = new Date() } = {}) {
  const habilitado = await isModuleEnabled('finops', tenant, transaction);
  const base = { modulo: 'finops', rotulo: 'FinOps', habilitado, fase: 'custos', itens: [] };
  if (!habilitado) return base;
  const params = await readFinopsParams(tenant, transaction);
  const to = readModel.dayKey(now);
  const from = readModel.dayKey(new Date(now.getTime() - (params.windowDays - 1) * 86400000));
  const series = await readModel.report(tenant, { from, to }, { includeShared }, transaction);
  return {
    ...base,
    custos: { moeda: params.currency, periodo: { de: from, ate: to }, estimado: series.estimated, faturado: series.billed, aviso: 'Estimado e faturado nunca são somados.' },
    coletores: await collectorStatus(tenant, transaction),
    orcamentos: await listViews(tenant, transaction, { now }),
  };
}

module.exports = { getOverview };
