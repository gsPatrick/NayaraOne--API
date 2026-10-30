'use strict';

const { THRESHOLDS } = require('./budgets/budget.constants');
const { collectorStatus } = require('./collectors/status');
const degradationRepo = require('./degradation/degradation.repository');
const { statusOf, worst } = require('./health.status');

const hourText = (value) => (value ? new Date(value).toISOString() : null);

/** Coletores com o estado: STALE quando a última coleta falhou (o último dado bom continua à vista); não é valor do `status` de custo. */
async function collectorStates(tenant, transaction) {
  return (await collectorStatus(tenant, transaction)).map((c) => ({
    collector: c.coletor, state: c.situacao === 'FAILED' ? 'STALE' : 'OK', lastDataAt: hourText(c.ultimoSucesso), lastRunAt: hourText(c.ultimaExecucao),
    lastFailureAt: hourText(c.ultimaFalha), lastErrorCode: c.codigoUltimaFalha, consecutiveFailures: c.falhasSeguidas,
  }));
}

const countByDetector = (findings) => findings.reduce((acc, f) => ({ ...acc, [f.detector]: (acc[f.detector] || 0) + 1 }), {});

function itemOf(budget, stale, findingsByDetector) {
  const percent = budget.percentual;
  const threshold = [...THRESHOLDS].reverse().find((t) => percent >= t) || null;
  const item = {
    dominio: budget.domain, orcamentoId: budget.id, orcamentoCentavos: budget.valorCentavos, percentual: percent, limiarAtual: threshold, status: statusOf(percent),
    consumo: { estimado: budget.consumo.estimado, faturado: budget.consumo.faturado, serieBase: budget.consumo.serieBase, consumidoCentavos: budget.consumo.consumidoCentavos },
    mes: budget.mes, achadosAbertos: findingsByDetector, dadoIncompleto: stale.length > 0,
  };
  if (stale.length) {
    const since = stale.map((c) => c.lastDataAt).filter(Boolean).sort()[0];
    item.aviso = `A última coleta de ${stale.map((c) => c.collector).join(', ')} falhou: o percentual pode estar incompleto${since ? ` (último dado bom em ${since})` : ''}.`;
  }
  return item;
}

/**
 * Saúde de custo (M9-D863 §3.4): por ambiente e domínio, orçamento, consumo (faturado e estimado separados), percentual, limiar atual, achados abertos por
 * detector (a empresa inteira: o achado não tem ambiente), coletores, degradações aplicadas e `status` por domínio, por ambiente e geral (o pior).
 * `budgets` são as visões já calculadas (budget.view) e `findings` os achados abertos (detectors/findings.repository).
 */
async function buildHealth(tenant, transaction, { budgets, findings }) {
  const collectors = await collectorStates(tenant, transaction);
  const stale = collectors.filter((c) => c.state === 'STALE');
  const byDetector = countByDetector(findings);
  const environments = new Map();
  for (const budget of budgets) {
    const list = environments.get(budget.environment) || [];
    list.push(itemOf(budget, stale, byDetector));
    environments.set(budget.environment, list);
  }
  const ambientes = [...environments.entries()].map(([ambiente, dominios]) => ({ ambiente, status: worst(dominios.map((d) => d.status)), dominios }));
  const recent = await degradationRepo.listRecent(tenant, transaction);
  return {
    status: worst(ambientes.map((a) => a.status)),
    ambientes,
    collectors,
    achadosPorDetector: byDetector,
    degradacoes: recent.map((a) => ({
      id: a.id, passo: a.step, ambiente: a.environment, dominio: a.domain, orcamentoId: a.budget_id, limiar: a.threshold, periodo: a.period_start, situacao: a.status,
      aplicadaEm: hourText(a.applied_at), desfeitaEm: hourText(a.reverted_at), motivoReversao: a.revert_reason,
    })),
  };
}

module.exports = { buildHealth, collectorStates };
