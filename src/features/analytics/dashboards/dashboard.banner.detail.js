'use strict';

/**
 * M9-D697 (reabertura F08/F10) — completa cada linha da faixa de qualidade com o MOTIVO e a data da última atualização da fonte (`detail`, `lastUpdateAt`), para a
 * tela dizer qual fonte está sem dado e desde quando, em vez de repetir "Dado incompleto". A linha de bloco (indicador que não é widget do painel) fica sem a data
 * quando o servidor não a trouxe. Só apresenta: nada é calculado.
 */
const { incompleteReason, lastUpdateOf } = require('./dashboard.reason');

/** views: widgets de indicador já compostos ({ metric }); banner: o retorno de buildQualityBanner. Devolve a mesma estrutura, com `detail` e `lastUpdateAt`. */
function withReasons(built, views, blocks = []) {
  const byCode = new Map(views.map((v) => [v.metric.metricCode, v.metric]));
  const reasonOf = new Map(blocks.flatMap((b) => b.block.reasons.map((r) => [r.metricCode, r])));
  const degradedMetrics = built.banner.degradedMetrics.map((d) => {
    const metric = byCode.get(d.metricCode);
    if (metric) return { ...d, detail: incompleteReason(metric), lastUpdateAt: lastUpdateOf(metric) };
    const r = reasonOf.get(d.metricCode);
    return { ...d, detail: d.detail || null, lastUpdateAt: (r && r.lastUpdateAt) || null };
  });
  return { banner: { ...built.banner, degradedMetrics }, quality: { ...built.quality, degradedMetrics } };
}

module.exports = { withReasons };
