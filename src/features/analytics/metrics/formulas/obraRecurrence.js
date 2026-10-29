'use strict';

/**
 * M9-D652 — KPI obra.recurrence (Recorrência por causa, equipe e material), versão 1. Ocorrência = não conformidade ou caso de garantia vinculado a uma
 * obra. Uma combinação (tipo + valor: causa X, equipe Y ou material Z) é RECORRENTE quando tem `minOccurrences` ou mais ocorrências distintas nos
 * últimos `windowDays` dias de calendário até a data-base (a de `windowDays` dias atrás ainda conta, a de `windowDays + 1` não), seja em obras
 * distintas ou na mesma obra. Valor = quantas combinações são recorrentes (COUNT); o ranking das `top` maiores (contagem, depois custo, depois chave)
 * traz contagem, obras afetadas e custo associado. Ocorrência sem causa, sem equipe ou sem material fica fora do ranking daquele tipo e é contada em
 * details.unclassified. Entrada (rm_project_occurrences): { asOfDate, notInformed, rows: [{ projectId, id, occurredOn, cause, teams, materials, cost }] }.
 * Parâmetros: { windowDays, minOccurrences, top, maxUnclassifiedPct }. Posição, natureza ACTUAL. Regra de qualidade: se a parte das ocorrências da janela sem causa, sem
 * equipe ou sem material passa de maxUnclassifiedPct (padrão 100: nunca, o livro manda contar), o KPI sai DEGRADED, sem valor; o ranking e a contagem seguem em details.
 */
const money = require('./money');
const { daysBetween } = require('./_dates');
const { degraded } = require('./_obraEstoqueKpi');

const KINDS = Object.freeze([['causa', 'cause'], ['equipe', 'teams'], ['material', 'materials']]);

/** Valores do tipo numa ocorrência: causa é um só; equipes e materiais são listas. Lista vazia ou só 'não informada' = sem classificação. */
const valuesOf = (row, field) => (Array.isArray(row[field]) ? row[field] : [row[field]]);

function groupsOf(rows, notInformed) {
  const groups = new Map();
  const unclassified = { causa: 0, equipe: 0, material: 0 };
  for (const row of rows) {
    for (const [kind, field] of KINDS) {
      const values = valuesOf(row, field).filter((v) => v !== undefined && v !== null && String(v).trim() !== '' && v !== notInformed);
      if (!values.length) { unclassified[kind] += 1; continue; }
      for (const value of new Set(values)) {
        const key = `${kind}:${value}`;
        const g = groups.get(key) || { key, kind, value, ids: new Set(), projects: new Set(), cost: 0 };
        if (!g.ids.has(row.id)) { g.ids.add(row.id); g.projects.add(row.projectId); g.cost = money.add(g.cost, row.cost || 0); }
        groups.set(key, g);
      }
    }
  }
  return { groups: [...groups.values()], unclassified };
}

function compute(input, params = {}) {
  const windowDays = Number.isInteger(params.windowDays) ? params.windowDays : 180;
  const minOccurrences = Number.isInteger(params.minOccurrences) ? params.minOccurrences : 2;
  const top = Number.isInteger(params.top) ? params.top : 10;
  const maxUnclassifiedPct = Number.isInteger(params.maxUnclassifiedPct) ? params.maxUnclassifiedPct : 100;
  const inWindow = (input.rows || []).filter((r) => {
    const age = daysBetween(r.occurredOn, input.asOfDate);
    return age >= 0 && age <= windowDays;
  });
  const { groups, unclassified } = groupsOf(inWindow, input.notInformed || 'NAO_INFORMADA');
  const recurrent = groups.filter((g) => g.ids.size >= minOccurrences)
    .sort((a, b) => b.ids.size - a.ids.size || money.cmp(b.cost, a.cost) || (a.key < b.key ? -1 : 1));
  const ranking = recurrent.slice(0, top).map((g) => ({ kind: g.kind, value: g.value, occurrences: String(g.ids.size), projects: String(g.projects.size), cost: money.money(g.cost) }));
  const dimensions = ranking.flatMap((r) => [
    { key: `${r.kind}:${r.value}`, value: r.occurrences }, { key: `${r.kind}:${r.value}:obras_qtd`, value: r.projects }, { key: `${r.kind}:${r.value}:custo_brl`, value: r.cost },
  ]);
  const details = { windowDays: String(windowDays), minOccurrences: String(minOccurrences), occurrencesInWindow: String(inWindow.length), ranking, unclassified: { causa: String(unclassified.causa), equipe: String(unclassified.equipe), material: String(unclassified.material) } };
  const worstPct = ['causa', 'equipe', 'material'].map((kind) => money.percent(unclassified[kind], inWindow.length).value).filter((v) => v !== null).sort(money.cmp).pop();
  if (worstPct !== undefined && money.cmp(worstPct, maxUnclassifiedPct) > 0) return degraded('OCORRENCIA_SEM_CLASSIFICACAO_ACIMA_DO_LIMITE', { ...details, unclassifiedPct: worstPct, maxUnclassifiedPct: String(maxUnclassifiedPct) }, dimensions);
  return { value: String(recurrent.length), status: 'OK', details, dimensions };
}

const NI = 'NAO_INFORMADA';
const occ = (id, projectId, occurredOn, cause, teams, materials, cost = '0') => ({ id, projectId, occurredOn, cause, teams, materials, cost });
const rk = (kind, value, occurrences, projects, cost) => ({ kind, value, occurrences, projects, cost });
const dimsOf = (list) => list.flatMap((r) => [{ key: `${r.kind}:${r.value}`, value: r.occurrences }, { key: `${r.kind}:${r.value}:obras_qtd`, value: r.projects }, { key: `${r.kind}:${r.value}:custo_brl`, value: r.cost }]);
const okOf = (value, inWindow, ranking, unclassified = { causa: '0', equipe: '0', material: '0' }, windowDays = '180') => ({
  value, status: 'OK', details: { windowDays, minOccurrences: '2', occurrencesInWindow: inWindow, ranking, unclassified }, dimensions: dimsOf(ranking),
});
const A = { asOfDate: '2026-10-28', notInformed: NI };

const testCases = [
  { kind: 'empty', name: 'nenhuma ocorrência: zero combinações recorrentes e ranking vazio', input: { ...A, rows: [] }, expected: okOf('0', '0', []) },
  { kind: 'single', name: 'uma ocorrência não é recorrência', input: { ...A, rows: [occ('o1', 'p1', '2026-10-01', 'UMIDADE', ['B'], ['Tinta'])] }, expected: okOf('0', '1', []) },
  {
    kind: 'typical', name: 'exemplo do livro: infiltração da equipe B em 5 ocorrências de 5 obras; a causa e a equipe são combinações recorrentes',
    input: { ...A, rows: ['p1', 'p2', 'p3', 'p4', 'p5'].map((p, i) => occ(`o${i}`, p, `2026-10-0${i + 1}`, 'INFILTRACAO', ['B'], [NI], '100.00')) },
    expected: okOf('2', '5', [rk('causa', 'INFILTRACAO', '5', '5', '500.00'), rk('equipe', 'B', '5', '5', '500.00')], { causa: '0', equipe: '0', material: '5' }),
  },
  {
    kind: 'period_edge', name: 'a ocorrência de 180 dias atrás conta; a de 181 dias não (2 em 181 dias não é recorrência)',
    input: { ...A, rows: [occ('o1', 'p1', '2026-05-01', 'A', [NI], [NI]), occ('o2', 'p1', '2026-10-28', 'A', [NI], [NI]), occ('o3', 'p2', '2026-04-30', 'B', [NI], [NI]), occ('o4', 'p2', '2026-10-28', 'B', [NI], [NI])] },
    expected: okOf('1', '3', [rk('causa', 'A', '2', '1', '0.00')], { causa: '0', equipe: '3', material: '3' }),
  },
  {
    kind: 'rounding', name: 'ranking: desempate por contagem, custo e chave; só as N maiores; custo somado em decimal exato (0,10 + 0,20 = 0,30)',
    input: { ...A, rows: [occ('o1', 'p1', '2026-10-01', 'X', [NI], [NI], '0.10'), occ('o2', 'p1', '2026-10-02', 'X', [NI], [NI], '0.20'), occ('o3', 'p2', '2026-10-03', 'Y', [NI], [NI], '0.30'), occ('o4', 'p2', '2026-10-04', 'Y', [NI], [NI], '0.30'), occ('o5', 'p3', '2026-10-05', 'Z', [NI], [NI], '0.30'), occ('o6', 'p3', '2026-10-06', 'Z', [NI], [NI], '0.30')] },
    params: { top: 2 }, expected: { ...okOf('3', '6', [rk('causa', 'Y', '2', '1', '0.60'), rk('causa', 'Z', '2', '1', '0.60')], { causa: '0', equipe: '6', material: '6' }) },
  },
  {
    kind: 'single', name: 'ocorrências sem equipe e sem material acima do limite de 50%: DEGRADED e sem valor, com o ranking em details', params: { maxUnclassifiedPct: 50 },
    input: { ...A, rows: [occ('o1', 'p1', '2026-10-01', 'X', [NI], [NI]), occ('o2', 'p2', '2026-10-02', 'X', [NI], [NI])] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'OCORRENCIA_SEM_CLASSIFICACAO_ACIMA_DO_LIMITE', windowDays: '180', minOccurrences: '2', occurrencesInWindow: '2', ranking: [rk('causa', 'X', '2', '2', '0.00')], unclassified: { causa: '0', equipe: '2', material: '2' }, unclassifiedPct: '100.00', maxUnclassifiedPct: '50' },
      dimensions: dimsOf([rk('causa', 'X', '2', '2', '0.00')]),
    },
  },
];

module.exports = { id: 'obra.recurrence', version: 1, compute, testCases };
