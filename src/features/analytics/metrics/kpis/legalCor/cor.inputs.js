'use strict';

/**
 * M9-D661 — entrada de cada fórmula dos KPIs do Correspondente a partir das linhas dos read models (cor.rows) e os parâmetros que a fórmula recebe.
 * Mapeamento puro (sem banco): os números chegam como texto inteiro e a fórmula faz a conta em decimal exato. Os casos "pendentes" do tempo de
 * análise são os do estágio em análise (lista do parâmetro analytics.correspondente.estagios_em_analise) no read model de estágios.
 */
const pendingOf = (r, p) => String(r.stages.filter((s) => p.inAnalysisStages.includes(s.stage)).reduce((acc, s) => acc + BigInt(s.count || 0), 0n));

const INPUTS = Object.freeze({
  'cor.cases_by_stage': (r) => ({ rows: r.stages }),
  'cor.approval_rate_by_provider': (r) => ({ rows: r.outcome }),
  'cor.analysis_time': (r, ctx) => ({ rows: r.outcome, pending: pendingOf(r, ctx.settings) }),
  'cor.commission': (r) => ({ rows: r.commission }),
});

const PARAMS = Object.freeze({
  'cor.cases_by_stage': (p) => ({ validStages: p.validStages }),
  'cor.approval_rate_by_provider': (p) => ({ minSample: p.minSample }),
});

module.exports = { INPUTS, PARAMS };
