'use strict';

/**
 * M9-D670 — KPI mkt.attribution (Atribuição e custo por lead), versão 1. Fluxo no mês de São Paulo da data-base, com a atribuição que o Marketing gravou
 * (M9-D431; o BI não reatribui nem recalcula janela): por campanha, leads atribuídos pelo toque LAST, custo por lead = custo ÷ leads (BRL, 2 casas; zero leads
 * ou custo desconhecido = INCOMPLETE para a campanha), vendas atribuídas (oportunidades ganhas originadas na campanha) e custo por venda = custo ÷ vendas. O
 * toque FIRST entra como dimensão adicional (`first:`). O valor é o custo por lead do conjunto (custo ÷ leads, só das campanhas com custo conhecido); sem
 * lead atribuído o KPI é INCOMPLETE, sem valor. Atribuição fora da janela (venda sem toque válido, rejeitada pelo Marketing) fica fora do cálculo e é contada em
 * `details.outsideWindow`; acima de `maxOutsideWindowPct` por cento (analytics.qualidade.max_fora_janela_pct, padrão 100 = só contar) o KPI sai DEGRADED, sem
 * valor. Entrada: { rows: [{ campaign, channels, hasCostLink, cost, leads, leadsFirst, sales }], outsideWindow } (a linha de UUID zero não entra).
 */
const money = require('./money');
const { NO_CAMPAIGN, channelKey, sumCounts, sumMoney, degraded, incomplete, exceedsPct, byText } = require('./_mktKpi');

const ratio = (cost, count) => (money.cmp(count, 0) > 0 ? money.money(money.div(cost, count)) : null);

function compute(input, params = {}) {
  const maxPct = Number.isInteger(params.maxOutsideWindowPct) && params.maxOutsideWindowPct >= 0 ? params.maxOutsideWindowPct : 100;
  const all = (input.rows || []).filter((r) => r.campaign !== NO_CAMPAIGN);
  const outside = money.count(input.outsideWindow || 0);
  const known = all.filter((r) => r.hasCostLink === true);
  const byCampaign = all.map((r) => ({
    campaign: r.campaign, channel: channelKey(r.channels), cost: r.hasCostLink === true ? money.money(r.cost || 0) : null, leads: money.count(r.leads || 0),
    costPerLead: r.hasCostLink === true ? ratio(r.cost || 0, r.leads || 0) : null, sales: money.count(r.sales || 0), costPerSale: r.hasCostLink === true ? ratio(r.cost || 0, r.sales || 0) : null,
    leadsFirst: money.count(r.leadsFirst || 0), costPerLeadFirst: r.hasCostLink === true ? ratio(r.cost || 0, r.leadsFirst || 0) : null,
  })).sort((a, b) => byText(a.campaign, b.campaign));
  const cost = sumMoney(known.map((r) => r.cost));
  const leads = sumCounts(known.map((r) => r.leads));
  const sales = sumCounts(known.map((r) => r.sales));
  const leadsFirst = sumCounts(known.map((r) => r.leadsFirst));
  const details = { model: 'last', cost, leads, sales, leadsFirst, outsideWindow: outside, maxOutsideWindowPct: String(maxPct), withoutCostCenter: all.filter((r) => r.hasCostLink !== true).map((r) => r.campaign).sort(byText), byCampaign };
  const salesBase = money.count(money.add(sumCounts(all.map((r) => r.sales)), outside));
  if (money.cmp(salesBase, 0) > 0 && exceedsPct(outside, salesBase, maxPct)) return degraded('ATRIBUICAO_FORA_DA_JANELA_ACIMA_DO_LIMITE', details);
  if (money.cmp(leads, 0) === 0) return incomplete('SEM_LEAD_ATRIBUIDO', details);
  const dimensions = [
    { key: 'leads_atribuidos_qtd', value: leads }, { key: 'vendas_atribuidas_qtd', value: sales }, { key: 'fora_da_janela_qtd', value: outside },
    { key: 'first:leads_atribuidos_qtd', value: leadsFirst },
  ];
  if (ratio(cost, sales) !== null) dimensions.push({ key: 'custo_por_venda_brl', value: ratio(cost, sales) });
  if (ratio(cost, leadsFirst) !== null) dimensions.push({ key: 'first:custo_por_lead_brl', value: ratio(cost, leadsFirst) });
  for (const c of byCampaign) {
    if (c.costPerLead !== null) dimensions.push({ key: `campanha:${c.campaign}:custo_por_lead_brl`, value: c.costPerLead });
    if (c.costPerSale !== null) dimensions.push({ key: `campanha:${c.campaign}:custo_por_venda_brl`, value: c.costPerSale });
  }
  return { value: ratio(cost, leads), status: 'OK', details, dimensions };
}

const row = (campaign, channels, cost, leads, sales, leadsFirst = 0, hasCostLink = true) => ({ campaign, channels, hasCostLink, cost, leads, sales, leadsFirst });
const camp = (campaign, channel, cost, leads, costPerLead, sales, costPerSale, leadsFirst, costPerLeadFirst) => ({ campaign, channel, cost, leads, costPerLead, sales, costPerSale, leadsFirst, costPerLeadFirst });
const base = (cost, leads, sales, leadsFirst, outside, byCampaign, extra = {}) => ({ model: 'last', cost, leads, sales, leadsFirst, outsideWindow: outside, maxOutsideWindowPct: '100', withoutCostCenter: [], byCampaign, ...extra });
const noValue = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma campanha: INCOMPLETE e sem valor', input: { rows: [], outsideWindow: 0 }, expected: noValue('INCOMPLETE', 'SEM_LEAD_ATRIBUIDO', base('0.00', '0', '0', '0', '0', [])) },
  {
    kind: 'single', name: 'uma campanha sem venda: custo por lead 10,00 e custo por venda indefinido',
    input: { rows: [row('c1', ['SITE'], '100.00', 10, 0)], outsideWindow: 0 },
    expected: {
      value: '10.00', status: 'OK', details: base('100.00', '10', '0', '0', '0', [camp('c1', 'SITE', '100.00', '10', '10.00', '0', null, '0', null)]),
      dimensions: [{ key: 'leads_atribuidos_qtd', value: '10' }, { key: 'vendas_atribuidas_qtd', value: '0' }, { key: 'fora_da_janela_qtd', value: '0' }, { key: 'first:leads_atribuidos_qtd', value: '0' }, { key: 'campanha:c1:custo_por_lead_brl', value: '10.00' }],
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: custo 3.200,00 e 40 leads = 80,00 por lead; 2 vendas = 1.600,00 por venda; FIRST com 32 leads = 100,00',
    input: { rows: [row('c1', ['WHATSAPP'], '3200.00', 40, 2, 32)], outsideWindow: 1 },
    expected: {
      value: '80.00', status: 'OK', details: base('3200.00', '40', '2', '32', '1', [camp('c1', 'WHATSAPP', '3200.00', '40', '80.00', '2', '1600.00', '32', '100.00')]),
      dimensions: [
        { key: 'leads_atribuidos_qtd', value: '40' }, { key: 'vendas_atribuidas_qtd', value: '2' }, { key: 'fora_da_janela_qtd', value: '1' }, { key: 'first:leads_atribuidos_qtd', value: '32' },
        { key: 'custo_por_venda_brl', value: '1600.00' }, { key: 'first:custo_por_lead_brl', value: '100.00' }, { key: 'campanha:c1:custo_por_lead_brl', value: '80.00' }, { key: 'campanha:c1:custo_por_venda_brl', value: '1600.00' },
      ],
    },
  },
  {
    kind: 'period_edge', name: 'campanha sem centro de custo fica de fora do conjunto e é listada; campanha com custo e sem lead fica INCOMPLETE para ela, mas o custo dela pesa no conjunto: 140,00 ÷ 9 = 15,56',
    input: { rows: [row('c1', ['SITE'], '90.00', 9, 0), row('c2', ['SITE'], '50.00', 0, 0), row('c3', ['SITE'], '0', 5, 1, 0, false)], outsideWindow: 0 },
    expected: {
      value: '15.56', status: 'OK', details: base('140.00', '9', '0', '0', '0', [camp('c1', 'SITE', '90.00', '9', '10.00', '0', null, '0', null), camp('c2', 'SITE', '50.00', '0', null, '0', null, '0', null), camp('c3', 'SITE', null, '5', null, '1', null, '0', null)], { withoutCostCenter: ['c3'] }),
      dimensions: [{ key: 'leads_atribuidos_qtd', value: '9' }, { key: 'vendas_atribuidas_qtd', value: '0' }, { key: 'fora_da_janela_qtd', value: '0' }, { key: 'first:leads_atribuidos_qtd', value: '0' }, { key: 'campanha:c1:custo_por_lead_brl', value: '10.00' }],
    },
  },
  {
    kind: 'rounding', name: 'custo por lead com dízima arredonda uma vez: 100,00 ÷ 3 = 33,33; 100,00 ÷ 8 = 12,50',
    input: { rows: [row('c1', ['SITE'], '100.00', 3, 8)], outsideWindow: 0 },
    expected: {
      value: '33.33', status: 'OK', details: base('100.00', '3', '8', '0', '0', [camp('c1', 'SITE', '100.00', '3', '33.33', '8', '12.50', '0', null)]),
      dimensions: [
        { key: 'leads_atribuidos_qtd', value: '3' }, { key: 'vendas_atribuidas_qtd', value: '8' }, { key: 'fora_da_janela_qtd', value: '0' }, { key: 'first:leads_atribuidos_qtd', value: '0' },
        { key: 'custo_por_venda_brl', value: '12.50' }, { key: 'campanha:c1:custo_por_lead_brl', value: '33.33' }, { key: 'campanha:c1:custo_por_venda_brl', value: '12.50' },
      ],
    },
  },
  {
    kind: 'period_edge', name: 'atribuição fora da janela acima do limite do administrador (25% de 4 vendas > 20%): DEGRADED e sem valor', params: { maxOutsideWindowPct: 20 },
    input: { rows: [row('c1', ['SITE'], '100.00', 10, 3)], outsideWindow: 1 }, expected: noValue('DEGRADED', 'ATRIBUICAO_FORA_DA_JANELA_ACIMA_DO_LIMITE', base('100.00', '10', '3', '0', '1', [camp('c1', 'SITE', '100.00', '10', '10.00', '3', '33.33', '0', null)], { maxOutsideWindowPct: '20' })),
  },
];

module.exports = { id: 'mkt.attribution', version: 1, compute, testCases };
