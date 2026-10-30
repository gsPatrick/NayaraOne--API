'use strict';

const { isModuleEnabled } = require('../governance.module');
const { readFinopsParams } = require('./finops.params');
const readModel = require('./costReadModel');
const { collectorStatus, detectorStatus } = require('./collectors/status');
const findings = require('./detectors/findings.repository');
const { listViews } = require('./budgets/budget.view');
const { buildHealth } = require('./health.service');

/**
 * FinOps — serviço do módulo. M9-D860: o custo técnico sai em DUAS séries separadas, `estimado` e `faturado`, cada uma com o seu total; nenhuma resposta
 * traz total que some as duas. O custo compartilhado (sem empresa) só aparece para quem administra o FinOps. M9-D863: `status` geral (o pior entre ambientes e domínios), `ambientes`, `collectors` (com STALE), `achadosPorDetector` e `degradacoes`; nada aqui altera a disponibilidade. Orçamentos e alertas: M9-D861 (`orcamentos`, com as duas séries lado a lado); detectores: M9-D862 (`achados` abertos e `detectores`).
 */
async function getOverview(tenant, transaction, { includeShared = false, now = new Date() } = {}) {
  const habilitado = await isModuleEnabled('finops', tenant, transaction);
  const base = { modulo: 'finops', rotulo: 'FinOps', habilitado, fase: 'custos', itens: [] };
  if (!habilitado) return base;
  const params = await readFinopsParams(tenant, transaction);
  const to = readModel.dayKey(now);
  const from = readModel.dayKey(new Date(now.getTime() - (params.windowDays - 1) * 86400000));
  const series = await readModel.report(tenant, { from, to }, { includeShared }, transaction);
  const budgets = await listViews(tenant, transaction, { now });
  const openFindings = await findings.listOpen(tenant, transaction);
  const health = await buildHealth(tenant, transaction, { budgets, findings: openFindings });
  return {
    ...base,
    ...health,
    custos: { moeda: params.currency, periodo: { de: from, ate: to }, estimado: series.estimated, faturado: series.billed, aviso: 'Estimado e faturado nunca são somados.' },
    coletores: await collectorStatus(tenant, transaction),
    orcamentos: budgets,
    achados: openFindings,
    detectores: await detectorStatus(tenant, transaction),
  };
}

module.exports = { getOverview };
