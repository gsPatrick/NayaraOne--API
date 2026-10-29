'use strict';

/**
 * M9-D670 — KPI mkt.campaigns (Campanhas ativas e encerradas), versão 1. Posição: na data-base, as campanhas ATIVAS (em andamento) e, no mês de São Paulo
 * da data-base, as ENCERRADAS (fim dentro do mês), por canal (os canais da campanha unidos por "+"; "SEM_CANAL" sem nenhum). O valor é a contagem de ativas;
 * as encerradas saem em `encerradas_qtd`. Campanha ativa ou encerrada no mês sem canal deixa o KPI DEGRADED, sem valor; campanha que o read model ainda não
 * recalculou (estado nulo) também. Entrada (rm_mkt_campaigns): { month: 'AAAA-MM', rows: [{ campaign, state, channels, endedOn }] }.
 */
const money = require('./money');
const { channelKey, groupSum, degraded, byText } = require('./_mktKpi');

function compute(input) {
  const rows = input.rows || [];
  if (rows.some((r) => !r.state)) return degraded('READ_MODEL_NAO_RECALCULADO', { campaigns: String(rows.length) });
  const counted = rows
    .map((r) => ({ key: channelKey(r.channels), noChannel: !(r.channels || []).length, active: r.state === 'RUNNING' ? 1 : 0, ended: r.state === 'ENDED' && String(r.endedOn || '').startsWith(input.month) ? 1 : 0 }))
    .filter((r) => r.active || r.ended);
  const withoutChannel = String(counted.filter((r) => r.noChannel).length);
  const active = money.count(counted.reduce((acc, r) => acc + r.active, 0));
  const ended = money.count(counted.reduce((acc, r) => acc + r.ended, 0));
  const byChannel = groupSum(counted, (r) => r.key, ['active', 'ended']).map(([channel, v]) => ({ channel, active: v.active, ended: v.ended }));
  const details = { active, endedInPeriod: ended, byChannel };
  if (withoutChannel !== '0') return degraded('CAMPANHA_SEM_CANAL', { ...details, withoutChannel });
  const dimensions = [{ key: 'encerradas_qtd', value: ended }];
  for (const c of [...byChannel].sort((a, b) => byText(a.channel, b.channel))) dimensions.push({ key: `canal:${c.channel}:ativas_qtd`, value: c.active }, { key: `canal:${c.channel}:encerradas_qtd`, value: c.ended });
  return { value: active, status: 'OK', details, dimensions };
}

const row = (campaign, state, channels, endedOn = null) => ({ campaign, state, channels, endedOn });
const okOf = (active, ended, byChannel) => ({
  value: active, status: 'OK', details: { active, endedInPeriod: ended, byChannel },
  dimensions: [{ key: 'encerradas_qtd', value: ended }, ...byChannel.flatMap((c) => [{ key: `canal:${c.channel}:ativas_qtd`, value: c.active }, { key: `canal:${c.channel}:encerradas_qtd`, value: c.ended }])],
});
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });
const ch = (channel, active, ended) => ({ channel, active, ended });
const month = '2026-10';

const testCases = [
  { kind: 'empty', name: 'nenhuma campanha: 0 ativas e 0 encerradas', input: { month, rows: [] }, expected: okOf('0', '0', []) },
  { kind: 'single', name: 'uma campanha em andamento no WhatsApp', input: { month, rows: [row('c1', 'RUNNING', ['WHATSAPP'])] }, expected: okOf('1', '0', [ch('WHATSAPP', '1', '0')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 5 ativas e 3 encerradas em outubro; rascunho, agendada e encerrada em setembro ficam de fora',
    input: {
      month, rows: [
        ...['a', 'b', 'c'].map((id) => row(id, 'RUNNING', ['WHATSAPP'])), row('d', 'RUNNING', ['EMAIL']), row('e', 'RUNNING', ['EMAIL', 'WHATSAPP']),
        row('f', 'ENDED', ['EMAIL'], '2026-10-03'), row('g', 'ENDED', ['EMAIL'], '2026-10-20'), row('h', 'ENDED', ['WHATSAPP'], '2026-10-31'),
        row('i', 'ENDED', ['EMAIL'], '2026-09-30'), row('j', 'DRAFT', ['EMAIL']), row('k', 'SCHEDULED', ['EMAIL']),
      ],
    },
    expected: okOf('5', '3', [ch('EMAIL', '1', '2'), ch('EMAIL+WHATSAPP', '1', '0'), ch('WHATSAPP', '3', '1')]),
  },
  { kind: 'period_edge', name: 'encerrada no primeiro dia do mês conta; no último dia do mês anterior não', input: { month, rows: [row('a', 'ENDED', ['EMAIL'], '2026-10-01'), row('b', 'ENDED', ['EMAIL'], '2026-09-30')] }, expected: okOf('0', '1', [ch('EMAIL', '0', '1')]) },
  { kind: 'rounding', name: 'contagem não arredonda: 7 ativas e 11 encerradas em canais diferentes', input: { month, rows: [...Array(7).fill(0).map((_, i) => row(`a${i}`, 'RUNNING', ['SITE'])), ...Array(11).fill(0).map((_, i) => row(`e${i}`, 'ENDED', ['PORTAL'], '2026-10-15'))] }, expected: okOf('7', '11', [ch('PORTAL', '0', '11'), ch('SITE', '7', '0')]) },
  { kind: 'period_edge', name: 'campanha ativa sem canal: DEGRADED e sem valor', input: { month, rows: [row('a', 'RUNNING', ['EMAIL']), row('b', 'RUNNING', [])] }, expected: bad('CAMPANHA_SEM_CANAL', { active: '2', endedInPeriod: '0', byChannel: [ch('EMAIL', '1', '0'), ch('SEM_CANAL', '1', '0')], withoutChannel: '1' }) },
  { kind: 'period_edge', name: 'campanha sem canal que nem está ativa nem encerrou no mês não rebaixa', input: { month, rows: [row('a', 'DRAFT', [])] }, expected: okOf('0', '0', []) },
  { kind: 'period_edge', name: 'estado ainda não calculado pelo read model: DEGRADED', input: { month, rows: [row('a', null, null)] }, expected: bad('READ_MODEL_NAO_RECALCULADO', { campaigns: '1' }) },
];

module.exports = { id: 'mkt.campaigns', version: 1, compute, testCases };
