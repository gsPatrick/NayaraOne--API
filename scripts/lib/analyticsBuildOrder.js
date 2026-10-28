'use strict';

/**
 * M9-D613 (Guia §1) — ordem exata de construção do BI. Cada passo tem as demandas cujo teste verde é o portão de saída.
 * Regra: uma demanda de um passo só pode estar `verificada` se todas as demandas dos passos anteriores também estão.
 */
const PASSOS = [
  { passo: 1, nome: 'metric registry', demandas: ['603'] },
  { passo: 2, nome: 'read models por domínio', demandas: ['607'] },
  { passo: 3, nome: 'snapshots e freshness', demandas: ['609'] },
  { passo: 4, nome: 'dashboard Financeiro', demandas: ['626'] },
  { passo: 5, nome: 'dashboards CRM e Obras', demandas: ['634', '653'] },
  { passo: 6, nome: 'alert engine', demandas: ['691'] },
  { passo: 7, nome: 'drill-down', demandas: ['690'] },
  { passo: 8, nome: 'data quality', demandas: ['696'] },
  { passo: 9, nome: 'NAY briefs', demandas: ['693'] },
  { passo: 10, nome: 'exports', demandas: ['701'] },
  { passo: 11, nome: 'carga, rebuild e segurança', demandas: ['699', '608', '700'] },
];

/** Devolve as violações da ordem para um mapa { '603': 'verificada', ... }. */
function violacoes(statusPorDemanda) {
  const ok = (d) => statusPorDemanda[d] === 'verificada';
  const out = [];
  PASSOS.forEach((p, i) => {
    if (!p.demandas.some(ok)) return;
    for (const ant of PASSOS.slice(0, i)) for (const d of ant.demandas) if (!ok(d)) out.push(`passo ${p.passo} adiantado: D${d} (passo ${ant.passo}) não está verificada`);
  });
  return out;
}

module.exports = Object.assign(PASSOS, { violacoes });
