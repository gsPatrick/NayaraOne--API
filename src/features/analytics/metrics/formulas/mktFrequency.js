'use strict';

/**
 * M9-D671 — KPI mkt.frequency (Frequência de contato), versão 1. Fluxo na janela que termina na data-base (parâmetro analytics.frequencia.janela_dias,
 * padrão 7): média de mensagens de automação ou campanha por pessoa alcançada (2 casas) e número de pessoas acima do teto de frequência
 * (`marketing.frequency_cap.global`, calculado pelo Marketing; deve ser zero), por canal. Sem linha do dia, linha calculada com outra janela ou
 * nenhuma pessoa alcançada = INCOMPLETE; mensagem sem destinatário identificável ou read model ainda não recalculado = DEGRADED; ambos sem valor. Entrada
 * (rm_mkt_frequency do dia): { row: { windowDays, windowMessages, windowPeople, unidentified, overCap, byChannel } | null }.
 */
const money = require('./money');
const { degraded, incomplete, byText } = require('./_mktKpi');

const average = (messages, people) => money.round(money.div(messages, people), 2);

function compute(input, params = {}) {
  const windowDays = Number.isInteger(params.windowDays) && params.windowDays >= 1 ? params.windowDays : 7;
  const r = input.row;
  if (!r) return incomplete('SEM_CALCULO_NO_DIA', { windowDays: String(windowDays) });
  if ([r.windowDays, r.windowMessages, r.windowPeople, r.unidentified, r.byChannel].some((v) => v === null || v === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', { windowDays: String(windowDays) });
  const details = { windowDays: String(windowDays), messages: money.count(r.windowMessages), people: money.count(r.windowPeople), overCap: money.count(r.overCap || 0) };
  if (r.windowDays !== windowDays) return incomplete('JANELA_DESATUALIZADA', { ...details, calculatedWithDays: String(r.windowDays) });
  if (money.cmp(r.unidentified, 0) > 0) return degraded('MENSAGEM_SEM_DESTINATARIO', { ...details, unidentified: money.count(r.unidentified) });
  if (money.cmp(r.windowPeople, 0) === 0) return incomplete('SEM_PESSOA_ALCANCADA', details);
  const channels = Object.keys(r.byChannel).sort(byText).filter((c) => money.cmp(r.byChannel[c].people, 0) > 0);
  const dimensions = [{ key: 'acima_do_teto_qtd', value: details.overCap }, { key: 'pessoas_alcancadas_qtd', value: details.people }, { key: 'mensagens_qtd', value: details.messages }];
  for (const c of channels) dimensions.push({ key: `canal:${c}:media`, value: average(r.byChannel[c].messages, r.byChannel[c].people) });
  return { value: average(r.windowMessages, r.windowPeople), status: 'OK', details: { ...details, byChannel: channels.map((c) => ({ channel: c, messages: money.count(r.byChannel[c].messages), people: money.count(r.byChannel[c].people) })) }, dimensions };
}

const row = (windowMessages, windowPeople, byChannel, extra = {}) => ({ windowDays: 7, windowMessages, windowPeople, unidentified: 0, overCap: 0, byChannel, ...extra });
const okOf = (value, messages, people, overCap, byChannel, windowDays = '7') => ({
  value, status: 'OK', details: { windowDays, messages, people, overCap, byChannel: byChannel.map((c) => ({ channel: c.channel, messages: c.messages, people: c.people })) },
  dimensions: [{ key: 'acima_do_teto_qtd', value: overCap }, { key: 'pessoas_alcancadas_qtd', value: people }, { key: 'mensagens_qtd', value: messages }, ...byChannel.map((c) => ({ key: `canal:${c.channel}:media`, value: c.avg }))],
});
const ch = (channel, messages, people, avg) => ({ channel, messages, people, avg });
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'sem linha do dia no read model: INCOMPLETE e sem valor', input: { row: null }, expected: bad('INCOMPLETE', 'SEM_CALCULO_NO_DIA', { windowDays: '7' }) },
  { kind: 'single', name: 'uma pessoa com uma mensagem: média 1,00', input: { row: row(1, 1, { WHATSAPP: { messages: 1, people: 1 } }) }, expected: okOf('1.00', '1', '1', '0', [ch('WHATSAPP', '1', '1', '1.00')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 18 mensagens para 10 pessoas = média 1,80, nenhuma acima do teto',
    input: { row: row(18, 10, { EMAIL: { messages: 6, people: 4 }, WHATSAPP: { messages: 12, people: 8 } }) },
    expected: okOf('1.80', '18', '10', '0', [ch('EMAIL', '6', '4', '1.50'), ch('WHATSAPP', '12', '8', '1.50')]),
  },
  {
    kind: 'period_edge', name: 'pessoas acima do teto aparecem em acima_do_teto_qtd sem tirar o valor; janela do administrador de 30 dias bate com a linha calculada em 30', params: { windowDays: 30 },
    input: { row: row(5, 2, { SMS: { messages: 5, people: 2 } }, { windowDays: 30, overCap: 1 }) }, expected: okOf('2.50', '5', '2', '1', [ch('SMS', '5', '2', '2.50')], '30'),
  },
  { kind: 'rounding', name: 'média arredonda uma vez: 10 mensagens para 3 pessoas = 3,33; 1 para 8 = 0,13', input: { row: row(10, 3, { EMAIL: { messages: 10, people: 3 } }) }, expected: okOf('3.33', '10', '3', '0', [ch('EMAIL', '10', '3', '3.33')]) },
  { kind: 'period_edge', name: 'linha calculada com janela de 7 dias e parâmetro agora em 14: INCOMPLETE até o recálculo', params: { windowDays: 14 }, input: { row: row(5, 2, { SMS: { messages: 5, people: 2 } }) }, expected: bad('INCOMPLETE', 'JANELA_DESATUALIZADA', { windowDays: '14', messages: '5', people: '2', overCap: '0', calculatedWithDays: '7' }) },
  { kind: 'period_edge', name: 'mensagem sem destinatário identificável: DEGRADED e sem valor', input: { row: row(5, 2, { SMS: { messages: 5, people: 2 } }, { unidentified: 1 }) }, expected: bad('DEGRADED', 'MENSAGEM_SEM_DESTINATARIO', { windowDays: '7', messages: '5', people: '2', overCap: '0', unidentified: '1' }) },
  { kind: 'period_edge', name: 'campos ainda não calculados: DEGRADED', input: { row: { windowDays: null, windowMessages: null, windowPeople: null, unidentified: null, overCap: 0, byChannel: null } }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', { windowDays: '7' }) },
];

module.exports = { id: 'mkt.frequency', version: 1, compute, testCases };
