'use strict';

/**
 * M9-D670 — KPI mkt.cost (Custo de marketing), versão 1. Fluxo: soma das SAÍDAS liquidadas ligadas a campanhas no mês de São Paulo da data-base (o
 * Financeiro é a fonte; nunca valor digitado), por campanha e canal; as pendentes do mês (a vencer) saem em `details.planned`, sem entrar no valor.
 * Campanha que já rodou no mês (ou tem despesa nele) e não tem centro de custo nem lançamento ligado a ela deixa o custo INCOMPLETE para ela e, por isso, o
 * KPI INCOMPLETE, sem valor (o número seria menor que o real). Entrada (rm_mkt_campaigns + rm_mkt_campaign_month do mês): { month, rows: [{ campaign,
 * state, channels, startedOn, endedOn, hasCostLink, settled, planned }] }.
 */
const money = require('./money');
const { channelKey, sumMoney, incomplete, byText } = require('./_mktKpi');

/** A campanha rodou no mês: em andamento ou encerrada, começou até o fim do mês e (se encerrada) acabou a partir do começo dele. */
const ranInMonth = (r, month) => (r.state === 'RUNNING' || r.state === 'ENDED') && (!r.startedOn || r.startedOn <= `${month}-31`) && (r.state === 'RUNNING' || !r.endedOn || r.endedOn >= `${month}-01`);

function compute(input) {
  const rows = input.rows || [];
  const unlinked = rows.filter((r) => r.hasCostLink !== true && (ranInMonth(r, input.month) || money.cmp(r.settled || 0, 0) > 0 || money.cmp(r.planned || 0, 0) > 0)).map((r) => r.campaign).sort(byText);
  const settled = sumMoney(rows.map((r) => r.settled));
  const planned = sumMoney(rows.map((r) => r.planned));
  const byCampaign = rows.filter((r) => money.cmp(r.settled || 0, 0) > 0 || money.cmp(r.planned || 0, 0) > 0).map((r) => ({ campaign: r.campaign, channel: channelKey(r.channels), settled: money.money(r.settled || 0), planned: money.money(r.planned || 0) })).sort((a, b) => byText(a.campaign, b.campaign));
  const details = { planned, campaigns: String(rows.length) };
  if (unlinked.length) return incomplete('CAMPANHA_SEM_CENTRO_DE_CUSTO', { ...details, settledKnown: settled, withoutCostCenter: unlinked });
  const channels = [...new Set(byCampaign.map((c) => c.channel))].sort(byText);
  const dimensions = [{ key: 'planejado_brl', value: planned }];
  for (const c of byCampaign) dimensions.push({ key: `campanha:${c.campaign}:custo_brl`, value: c.settled });
  for (const channel of channels) dimensions.push({ key: `canal:${channel}:custo_brl`, value: sumMoney(byCampaign.filter((c) => c.channel === channel).map((c) => c.settled)) });
  return { value: settled, status: 'OK', details: { ...details, byCampaign }, dimensions };
}

const row = (campaign, channels, settled, planned = '0', extra = {}) => ({ campaign, state: 'RUNNING', channels, startedOn: '2026-10-01', endedOn: null, hasCostLink: true, settled, planned, ...extra });
const okOf = (value, planned, campaigns, byCampaign, channelDims) => ({
  value, status: 'OK', details: { planned, campaigns, byCampaign },
  dimensions: [{ key: 'planejado_brl', value: planned }, ...byCampaign.map((c) => ({ key: `campanha:${c.campaign}:custo_brl`, value: c.settled })), ...channelDims],
});
const cp = (campaign, channel, settled, planned) => ({ campaign, channel, settled, planned });
const month = '2026-10';

const testCases = [
  { kind: 'empty', name: 'nenhuma campanha: custo 0,00', input: { month, rows: [] }, expected: okOf('0.00', '0.00', '0', [], []) },
  { kind: 'single', name: 'uma campanha com R$ 3.200,00 liquidados: custo 3.200,00', input: { month, rows: [row('c1', ['WHATSAPP'], '3200.00')] }, expected: okOf('3200.00', '0.00', '1', [cp('c1', 'WHATSAPP', '3200.00', '0.00')], [{ key: 'canal:WHATSAPP:custo_brl', value: '3200.00' }]) },
  {
    kind: 'typical', name: 'duas campanhas e dois canais: liquidado soma, pendente fica à parte em details.planned',
    input: { month, rows: [row('c1', ['WHATSAPP'], '2000.10', '500.00'), row('c2', ['EMAIL', 'WHATSAPP'], '1199.90', '0'), row('c3', ['EMAIL'], '100.00', '50.25')] },
    expected: okOf('3300.00', '550.25', '3', [cp('c1', 'WHATSAPP', '2000.10', '500.00'), cp('c2', 'EMAIL+WHATSAPP', '1199.90', '0.00'), cp('c3', 'EMAIL', '100.00', '50.25')], [
      { key: 'canal:EMAIL:custo_brl', value: '100.00' }, { key: 'canal:EMAIL+WHATSAPP:custo_brl', value: '1199.90' }, { key: 'canal:WHATSAPP:custo_brl', value: '2000.10' },
    ]),
  },
  {
    kind: 'period_edge', name: 'campanha encerrada em setembro, sem centro de custo e sem despesa em outubro, não rebaixa o custo de outubro',
    input: { month, rows: [row('c1', ['EMAIL'], '10.00'), row('velha', ['EMAIL'], '0', '0', { state: 'ENDED', startedOn: '2026-08-01', endedOn: '2026-09-30', hasCostLink: false })] },
    expected: okOf('10.00', '0.00', '2', [cp('c1', 'EMAIL', '10.00', '0.00')], [{ key: 'canal:EMAIL:custo_brl', value: '10.00' }]),
  },
  { kind: 'rounding', name: 'centavos exatos: 0,10 + 0,20 = 0,30 (sem erro de ponto flutuante)', input: { month, rows: [row('c1', ['SITE'], '0.10'), row('c2', ['SITE'], '0.20')] }, expected: okOf('0.30', '0.00', '2', [cp('c1', 'SITE', '0.10', '0.00'), cp('c2', 'SITE', '0.20', '0.00')], [{ key: 'canal:SITE:custo_brl', value: '0.30' }]) },
  {
    kind: 'period_edge', name: 'campanha em andamento sem centro de custo: INCOMPLETE e sem valor (custo conhecido em details)',
    input: { month, rows: [row('c1', ['EMAIL'], '10.00'), row('c2', ['EMAIL'], '0', '0', { hasCostLink: false })] },
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'CAMPANHA_SEM_CENTRO_DE_CUSTO', planned: '0.00', campaigns: '2', settledKnown: '10.00', withoutCostCenter: ['c2'] }, dimensions: [] },
  },
];

module.exports = { id: 'mkt.cost', version: 1, compute, testCases };
