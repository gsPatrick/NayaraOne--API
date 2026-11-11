'use strict';

/**
 * Montagem das explicações da assistente financeira (Caderno §18) a partir do READ MODEL (Guia M4 §13). Puro: recebe a linha de analytics.rm_finance_health e as linhas
 * de analytics.rm_finance_sector_margin já lidas e devolve as seções com número, natureza (REALIZADO/PREVISTO/ESTIMADO) e fonte. Dinheiro em centavos
 * inteiros (domain/money.js): o read model guarda numeric e chega como texto decimal exato.
 */
const { toCents } = require('../../domain/money');

/** Texto decimal do read model -> número para a resposta (centavos exatos / 100), ou null quando não há retrato. */
const brl = (value) => (value === null || value === undefined ? null : toCents(value) / 100);
const fmt = (value) => (value === null ? 'indisponível' : `R$ ${value.toFixed(2)}`);

/** Receita e custo realizados (centavos) de um mês, somando os setores. */
function monthTotals(margins, month) {
  const rows = margins.filter((m) => m.competence_month === month);
  return { revenue: rows.reduce((a, m) => a + toCents(m.revenue), 0), cost: rows.reduce((a, m) => a + toCents(m.cost), 0) };
}

function delinquencyRatio(health) {
  if (!health) return null;
  const base = toCents(health.receivables_base);
  return base > 0 ? Math.round((toCents(health.overdue_in_window) * 10000) / base) / 10000 : 0;
}

/**
 * Seções "fluxo de caixa, variações, inadimplência, necessidade de capital e anomalias" (Caderno §18) com os campos do FinanceHealthReport (Guia §13).
 * @param {{ health: any, margins: any[], current: string, previous: string, fonteReadModel: any, fonteSetores: any }} input
 */
function buildExplanations({ health, margins, current, previous, fonteReadModel, fonteSetores }) {
  const h = health || {};
  const v = (field) => (health ? brl(h[field]) : null);
  const freeCash = v('free_cash');
  const thirdParty = v('third_party_cash');
  const rec7 = v('receivables_7d');
  const pay7 = v('payables_7d');
  const overdue = v('overdue_amount');
  const breathing = v('breathing_need');
  const atual = monthTotals(margins, current);
  const anterior = monthTotals(margins, previous);
  const netAtualCents = atual.revenue - atual.cost;
  const netAnteriorCents = anterior.revenue - anterior.cost;
  const ratio = delinquencyRatio(health);

  return {
    fluxoCaixa: {
      texto: `Caixa livre de ${fmt(freeCash)} (dinheiro de terceiros retido: ${fmt(thirdParty)}). Nos próximos 7 dias: ${fmt(rec7)} a receber e ${fmt(pay7)} a pagar; em 30 dias: ${fmt(v('receivables_30d'))} a receber e ${fmt(v('payables_30d'))} a pagar.`,
      numeros: [
        { indicador: 'caixaLivre', valor: freeCash, natureza: 'REALIZADO', fontes: [fonteReadModel] },
        { indicador: 'dinheiroTerceirosRetido', valor: thirdParty, natureza: 'REALIZADO', fontes: [fonteReadModel] },
        { indicador: 'aReceber7d', valor: rec7, natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'aPagar7d', valor: pay7, natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'aReceber30d', valor: v('receivables_30d'), natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'aPagar30d', valor: v('payables_30d'), natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'repassesPendentes', valor: v('pending_owner_repasses'), natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'comissoesProvisionadas', valor: v('provisioned_commissions'), natureza: 'PREVISTO', fontes: [fonteReadModel] },
      ],
    },
    variacoes: {
      texto: `Resultado realizado de ${current} (receita menos custo por competência): R$ ${(netAtualCents / 100).toFixed(2)}; de ${previous}: R$ ${(netAnteriorCents / 100).toFixed(2)} (variação R$ ${((netAtualCents - netAnteriorCents) / 100).toFixed(2)}).`,
      numeros: [
        { indicador: `recebido_${current}`, valor: atual.revenue / 100, natureza: 'REALIZADO', fontes: [fonteSetores] },
        { indicador: `pago_${current}`, valor: atual.cost / 100, natureza: 'REALIZADO', fontes: [fonteSetores] },
        { indicador: `recebido_${previous}`, valor: anterior.revenue / 100, natureza: 'REALIZADO', fontes: [fonteSetores] },
        { indicador: `pago_${previous}`, valor: anterior.cost / 100, natureza: 'REALIZADO', fontes: [fonteSetores] },
        { indicador: 'variacaoResultado', valor: (netAtualCents - netAnteriorCents) / 100, natureza: 'REALIZADO', fontes: [fonteSetores] },
      ],
    },
    inadimplencia: {
      texto: `${fmt(overdue)} a receber vencido; índice de vencidos sobre o total elegível: ${ratio === null ? 'indisponível' : `${(ratio * 100).toFixed(2)}%`}.`,
      numeros: [
        { indicador: 'recebiveisVencidos', valor: overdue, natureza: 'REALIZADO', fontes: [fonteReadModel] },
        { indicador: 'indiceInadimplencia', valor: ratio, natureza: 'REALIZADO', fontes: [fonteReadModel] },
      ],
    },
    necessidadeCapital: {
      texto:
        breathing === null
          ? 'Necessidade de capital indisponível enquanto o retrato financeiro não for calculado.'
          : breathing > 0
            ? `Estimativa de necessidade de R$ ${breathing.toFixed(2)} para cobrir as saídas obrigatórias próximas (saídas obrigatórias − caixa livre − entradas prováveis).`
            : `Sem necessidade de capital estimada (folga de R$ ${Math.abs(breathing).toFixed(2)}).`,
      numeros: [{ indicador: 'necessidadeParaRespirar', valor: breathing, natureza: 'ESTIMADO', fontes: [fonteReadModel] }],
    },
    anomalias: {
      texto: `${health ? h.open_anomalies_high : 'indisponível'} caso(s) de anomalia de alto risco em aberto (${health ? h.open_anomalies : 'indisponível'} no total); ${health ? h.pending_reconciliations : 'indisponível'} transação(ões) de extrato sem conciliação.`,
      numeros: [
        { indicador: 'anomaliasAltoRisco', valor: health ? h.open_anomalies_high : null, natureza: 'REALIZADO', fontes: [fonteReadModel] },
        { indicador: 'conciliacoesPendentes', valor: health ? h.pending_reconciliations : null, natureza: 'REALIZADO', fontes: [fonteReadModel] },
      ],
    },
  };
}

/**
 * Setores (centros de resultado) cujo custo realizado cresceu do mês anterior para o atual, os 5 maiores (sugestão de redução de custo).
 * @param {any[]} margins @param {string} current @param {string} previous @param {(ids: string[]) => Promise<Map<string, string>>} namesOf
 */
async function buildSectorGrowth(margins, current, previous, namesOf) {
  const by = new Map();
  for (const m of margins) {
    if (!by.has(m.result_center_id)) by.set(m.result_center_id, { atual: 0, anterior: 0 });
    by.get(m.result_center_id)[m.competence_month === current ? 'atual' : 'anterior'] += toCents(m.cost);
  }
  const grown = [...by.entries()].filter(([, c]) => c.atual - c.anterior > 0).sort((a, b) => (b[1].atual - b[1].anterior) - (a[1].atual - a[1].anterior)).slice(0, 5);
  const names = await namesOf(grown.map(([id]) => id).filter((id) => !/^0{8}-/.test(id)));
  return grown.map(([id, c]) => ({
    resultCenterId: id,
    nome: names.get(id) || (/^0{8}-/.test(id) ? 'Sem setor' : null),
    mesAtual: c.atual / 100,
    mesAnterior: c.anterior / 100,
    crescimento: (c.atual - c.anterior) / 100,
  }));
}

module.exports = { buildExplanations, buildSectorGrowth, monthTotals, delinquencyRatio };
