'use strict';

/**
 * M9-D670 — KPI mkt.leads (Leads de marketing), versão 1. Fluxo: leads com origem de marketing criados no mês de São Paulo da data-base, por campanha
 * (e canal), incluindo os sem campanha em "Sem campanha". O valor é o total (com e sem campanha); `sem_campanha_qtd` e `details.attributed` separam
 * os dois. Mais de `maxNoCampaignPct` por cento sem campanha (parâmetro analytics.qualidade.max_sem_campanha_pct, padrão 20) deixa o KPI DEGRADED, sem
 * valor; nenhum lead no mês deixa INCOMPLETE. Entrada (rm_mkt_campaign_month do mês + canais de rm_mkt_campaigns): { rows: [{ campaign, channels, leads }] }
 * (a campanha de UUID zero é "Sem campanha").
 */
const money = require('./money');
const { NO_CAMPAIGN, channelKey, sumCounts, groupSum, pct, degraded, incomplete, exceedsPct, byText } = require('./_mktKpi');

function compute(input, params = {}) {
  const maxPct = Number.isInteger(params.maxNoCampaignPct) && params.maxNoCampaignPct >= 0 ? params.maxNoCampaignPct : 20;
  const rows = (input.rows || []).filter((r) => money.cmp(r.leads || 0, 0) > 0);
  const without = sumCounts(rows.filter((r) => r.campaign === NO_CAMPAIGN).map((r) => r.leads));
  const attributed = sumCounts(rows.filter((r) => r.campaign !== NO_CAMPAIGN).map((r) => r.leads));
  const total = money.count(money.add(without, attributed));
  if (money.cmp(total, 0) === 0) return incomplete('SEM_LEAD_NO_PERIODO', { total, attributed, withoutCampaign: without, maxNoCampaignPct: String(maxPct) });
  const share = pct(without, total);
  const byCampaign = rows.filter((r) => r.campaign !== NO_CAMPAIGN).map((r) => ({ campaign: r.campaign, channel: channelKey(r.channels), leads: money.count(r.leads) })).sort((a, b) => byText(a.campaign, b.campaign));
  const details = { total, attributed, withoutCampaign: without, withoutCampaignPct: share, maxNoCampaignPct: String(maxPct), byCampaign };
  if (exceedsPct(without, total, maxPct)) return degraded('LEADS_SEM_CAMPANHA_ACIMA_DO_LIMITE', details);
  const dimensions = [{ key: 'sem_campanha_qtd', value: without }, { key: 'sem_campanha_pct', value: share }];
  for (const c of byCampaign) dimensions.push({ key: `campanha:${c.campaign}:leads_qtd`, value: c.leads });
  for (const [channel, v] of groupSum(byCampaign, (c) => c.channel, ['leads'])) dimensions.push({ key: `canal:${channel}:leads_qtd`, value: v.leads });
  return { value: total, status: 'OK', details, dimensions };
}

const NIL = '00000000-0000-0000-0000-000000000000';
const row = (campaign, channels, leads) => ({ campaign, channels, leads });
const okOf = (total, attributed, without, share, byCampaign, channelDims, max = '20') => ({
  value: total, status: 'OK', details: { total, attributed, withoutCampaign: without, withoutCampaignPct: share, maxNoCampaignPct: max, byCampaign },
  dimensions: [{ key: 'sem_campanha_qtd', value: without }, { key: 'sem_campanha_pct', value: share }, ...byCampaign.map((c) => ({ key: `campanha:${c.campaign}:leads_qtd`, value: c.leads })), ...channelDims],
});
const bc = (campaign, channel, leads) => ({ campaign, channel, leads });

const testCases = [
  { kind: 'empty', name: 'nenhum lead no mês: INCOMPLETE e sem valor', input: { rows: [] }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_LEAD_NO_PERIODO', total: '0', attributed: '0', withoutCampaign: '0', maxNoCampaignPct: '20' }, dimensions: [] } },
  { kind: 'single', name: 'um lead de uma campanha', input: { rows: [row('c1', ['SITE'], 1)] }, expected: okOf('1', '1', '0', '0.00', [bc('c1', 'SITE', '1')], [{ key: 'canal:SITE:leads_qtd', value: '1' }]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 40 atribuídos e 8 sem campanha = 48 leads, 16,67% sem campanha (abaixo de 20%)',
    input: { rows: [row('c1', ['WHATSAPP'], 25), row('c2', ['EMAIL'], 15), row(NIL, [], 8)] },
    expected: okOf('48', '40', '8', '16.67', [bc('c1', 'WHATSAPP', '25'), bc('c2', 'EMAIL', '15')], [{ key: 'canal:EMAIL:leads_qtd', value: '15' }, { key: 'canal:WHATSAPP:leads_qtd', value: '25' }]),
  },
  {
    kind: 'period_edge', name: 'exatamente 20% sem campanha não rebaixa; um lead a mais passa do limite e deixa DEGRADED',
    input: { rows: [row('c1', ['SITE'], 8), row(NIL, [], 2)] }, expected: okOf('10', '8', '2', '20.00', [bc('c1', 'SITE', '8')], [{ key: 'canal:SITE:leads_qtd', value: '8' }]),
  },
  {
    kind: 'rounding', name: 'percentual sem campanha arredonda uma vez: 1 de 3 = 33,33%; limite do administrador em 40% mantém o valor', params: { maxNoCampaignPct: 40 },
    input: { rows: [row('c1', ['SITE'], 2), row(NIL, [], 1)] }, expected: okOf('3', '2', '1', '33.33', [bc('c1', 'SITE', '2')], [{ key: 'canal:SITE:leads_qtd', value: '2' }], '40'),
  },
  {
    kind: 'period_edge', name: 'mais de 20% sem campanha: DEGRADED e sem valor',
    input: { rows: [row('c1', ['SITE'], 7), row(NIL, [], 3)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'LEADS_SEM_CAMPANHA_ACIMA_DO_LIMITE', total: '10', attributed: '7', withoutCampaign: '3', withoutCampaignPct: '30.00', maxNoCampaignPct: '20', byCampaign: [bc('c1', 'SITE', '7')] }, dimensions: [] },
  },
];

module.exports = { id: 'mkt.leads', version: 1, compute, testCases };
