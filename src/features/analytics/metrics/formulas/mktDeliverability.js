'use strict';

/**
 * M9-D671 — KPI mkt.deliverability (Entregabilidade), versão 1. Fluxo no mês de São Paulo da data-base, das mensagens de saída de automação ou campanha
 * (com action_key): entregabilidade = entregues ÷ enviadas × 100 (2 casas), por canal e campanha; falhas e devolvidas em `details`; nenhuma enviada = INCOMPLETE.
 * Regra de qualidade: mensagem sem status final de entrega há mais de `maxDeliveryHours` horas (parâmetro analytics.qualidade.mkt_entrega_max_horas, padrão
 * 24) deixa o KPI DEGRADED, sem valor, assim como read model ainda não recalculado. Entrada (rm_mkt_delivery dos dias do mês): { staleSince, rows: [{ day,
 * channel, sent, delivered, failed, bounced, byCampaign }] }; `staleSince` é o instante da mensagem sem status mais antiga SE ela já passou do limite de horas
 * (a conta com o relógio do BI é da entrada, para a entrada só mudar quando a regra muda), senão nulo; `failed` soma FAILED, UNDELIVERED e BOUNCED (as
 * devolvidas são parte dele).
 */
const money = require('./money');
const { sumCounts, groupSum, pct, degraded, incomplete, byText } = require('./_mktKpi');

function compute(input, params = {}) {
  const maxHours = Number.isInteger(params.maxDeliveryHours) && params.maxDeliveryHours >= 1 ? params.maxDeliveryHours : 24;
  const rows = input.rows || [];
  const sent = sumCounts(rows.map((r) => r.sent));
  const delivered = sumCounts(rows.map((r) => r.delivered));
  if (rows.some((r) => r.bounced === null || r.bounced === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', { sent, delivered });
  const bounced = sumCounts(rows.map((r) => r.bounced));
  const failed = money.count(money.sub(sumCounts(rows.map((r) => r.failed)), bounced));
  const details = { sent, delivered, failed, bounced, maxDeliveryHours: String(maxHours) };
  if (input.staleSince) return degraded('ENTREGA_SEM_STATUS_ALEM_DO_LIMITE', { ...details, oldestAwaitingSince: input.staleSince });
  if (money.cmp(sent, 0) === 0) return incomplete('SEM_MENSAGEM_ENVIADA', details);
  const byChannel = groupSum(rows, (r) => r.channel, ['sent', 'delivered']).map(([channel, v]) => ({ channel, ...v, rate: pct(v.delivered, v.sent) }));
  const campaigns = new Map();
  for (const r of rows) {
    for (const [id, v] of Object.entries(r.byCampaign || {})) {
      const acc = campaigns.get(id) || { sent: '0', delivered: '0' };
      campaigns.set(id, { sent: money.count(money.add(acc.sent, v.sent)), delivered: money.count(money.add(acc.delivered, v.delivered)) });
    }
  }
  const byCampaign = [...campaigns.entries()].sort((a, b) => byText(a[0], b[0])).map(([campaign, v]) => ({ campaign, ...v, rate: pct(v.delivered, v.sent) }));
  const dimensions = [{ key: 'enviadas_qtd', value: sent }, { key: 'entregues_qtd', value: delivered }, { key: 'falhas_qtd', value: failed }, { key: 'devolvidas_qtd', value: bounced }];
  for (const c of byChannel) dimensions.push({ key: `canal:${c.channel}:enviadas_qtd`, value: c.sent }, { key: `canal:${c.channel}:entregabilidade_pct`, value: c.rate });
  for (const c of byCampaign) dimensions.push({ key: `campanha:${c.campaign}:entregabilidade_pct`, value: c.rate });
  return { value: pct(delivered, sent), status: 'OK', details: { ...details, byChannel, byCampaign }, dimensions };
}

const row = (channel, sent, delivered, failed, bounced, extra = {}) => ({ day: '2026-10-20', channel, sent, delivered, failed, bounced, byCampaign: {}, ...extra });
const ok = (value, details, dimensions) => ({ value, status: 'OK', details, dimensions });
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });
const ch = (channel, sent, delivered, rate) => ({ channel, sent, delivered, rate });

const testCases = [
  { kind: 'empty', name: 'nenhuma mensagem enviada no mês: INCOMPLETE e sem valor', input: { staleSince: null, rows: [] }, expected: bad('INCOMPLETE', 'SEM_MENSAGEM_ENVIADA', { sent: '0', delivered: '0', failed: '0', bounced: '0', maxDeliveryHours: '24' }) },
  {
    kind: 'single', name: 'uma mensagem entregue: 100,00%', input: { staleSince: null, rows: [row('EMAIL', 1, 1, 0, 0)] },
    expected: ok('100.00', { sent: '1', delivered: '1', failed: '0', bounced: '0', maxDeliveryHours: '24', byChannel: [ch('EMAIL', '1', '1', '100.00')], byCampaign: [] }, [
      { key: 'enviadas_qtd', value: '1' }, { key: 'entregues_qtd', value: '1' }, { key: 'falhas_qtd', value: '0' }, { key: 'devolvidas_qtd', value: '0' },
      { key: 'canal:EMAIL:enviadas_qtd', value: '1' }, { key: 'canal:EMAIL:entregabilidade_pct', value: '100.00' },
    ]),
  },
  {
    kind: 'typical', name: 'exemplo da demanda: enviadas 2.000 e entregues 1.930 = 96,50%; falhas e devolvidas à parte; por canal e campanha',
    input: { staleSince: null, rows: [row('WHATSAPP', 1200, 1170, 20, 5, { byCampaign: { c1: { sent: 1000, delivered: 980 }, SEM_CAMPANHA: { sent: 200, delivered: 190 } } }), row('EMAIL', 800, 760, 30, 10, { day: '2026-10-21', byCampaign: { c1: { sent: 800, delivered: 760 } } })] },
    expected: ok('96.50', { sent: '2000', delivered: '1930', failed: '35', bounced: '15', maxDeliveryHours: '24', byChannel: [ch('EMAIL', '800', '760', '95.00'), ch('WHATSAPP', '1200', '1170', '97.50')], byCampaign: [{ campaign: 'SEM_CAMPANHA', sent: '200', delivered: '190', rate: '95.00' }, { campaign: 'c1', sent: '1800', delivered: '1740', rate: '96.67' }] }, [
      { key: 'enviadas_qtd', value: '2000' }, { key: 'entregues_qtd', value: '1930' }, { key: 'falhas_qtd', value: '35' }, { key: 'devolvidas_qtd', value: '15' },
      { key: 'canal:EMAIL:enviadas_qtd', value: '800' }, { key: 'canal:EMAIL:entregabilidade_pct', value: '95.00' }, { key: 'canal:WHATSAPP:enviadas_qtd', value: '1200' }, { key: 'canal:WHATSAPP:entregabilidade_pct', value: '97.50' },
      { key: 'campanha:SEM_CAMPANHA:entregabilidade_pct', value: '95.00' }, { key: 'campanha:c1:entregabilidade_pct', value: '96.67' },
    ]),
  },
  {
    kind: 'period_edge', name: 'nenhuma mensagem passou do limite de horas sem status: o valor aparece',
    input: { staleSince: null, rows: [row('EMAIL', 10, 9, 1, 0)] },
    expected: ok('90.00', { sent: '10', delivered: '9', failed: '1', bounced: '0', maxDeliveryHours: '24', byChannel: [ch('EMAIL', '10', '9', '90.00')], byCampaign: [] }, [
      { key: 'enviadas_qtd', value: '10' }, { key: 'entregues_qtd', value: '9' }, { key: 'falhas_qtd', value: '1' }, { key: 'devolvidas_qtd', value: '0' },
      { key: 'canal:EMAIL:enviadas_qtd', value: '10' }, { key: 'canal:EMAIL:entregabilidade_pct', value: '90.00' },
    ]),
  },
  { kind: 'rounding', name: 'taxa arredonda uma vez: 2 de 3 = 66,67%; 1 de 8 = 12,50%', input: { staleSince: null, rows: [row('SITE', 3, 2, 1, 0)] }, expected: ok('66.67', { sent: '3', delivered: '2', failed: '1', bounced: '0', maxDeliveryHours: '24', byChannel: [ch('SITE', '3', '2', '66.67')], byCampaign: [] }, [
    { key: 'enviadas_qtd', value: '3' }, { key: 'entregues_qtd', value: '2' }, { key: 'falhas_qtd', value: '1' }, { key: 'devolvidas_qtd', value: '0' }, { key: 'canal:SITE:enviadas_qtd', value: '3' }, { key: 'canal:SITE:entregabilidade_pct', value: '66.67' },
  ]) },
  {
    kind: 'period_edge', name: 'mensagem sem status além do limite de horas: DEGRADED e sem valor', input: { staleSince: '2026-10-27T14:59:00.000Z', rows: [row('EMAIL', 10, 9, 1, 0)] },
    expected: bad('DEGRADED', 'ENTREGA_SEM_STATUS_ALEM_DO_LIMITE', { sent: '10', delivered: '9', failed: '1', bounced: '0', maxDeliveryHours: '24', oldestAwaitingSince: '2026-10-27T14:59:00.000Z' }),
  },
  { kind: 'period_edge', name: 'devolvidas ainda não calculadas pelo read model: DEGRADED', input: { staleSince: null, rows: [row('EMAIL', 10, 9, 1, null)] }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', { sent: '10', delivered: '9' }) },
];

module.exports = { id: 'mkt.deliverability', version: 1, compute, testCases };
