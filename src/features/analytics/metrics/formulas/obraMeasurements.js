'use strict';

/**
 * M9-D651 — KPI obra.measurements (Medições), versão 1. Posição no fim do dia-base. Medido = medições enviadas em diante, aprovado = aprovadas
 * (e a pagar), pendente de aprovação = medido − aprovado; idade, em dias de calendário de São Paulo, da medição pendente mais antiga. Valor =
 * valor medido da empresa (BRL); dimensões: aprovado_brl, pendente_brl, pendente_mais_antiga_dias (só quando há pendência) e, por obra, o medido,
 * o aprovado e o pendente. Entrada: { asOfDate, projects: [{ id, measured, approved, oldestPendingSince, approvedWithoutPayment }] } com os
 * valores do read model rm_project_measurements (M9-D618). Regra de qualidade: medição aprovada sem lançamento de pagamento previsto em qualquer
 * obra -> DEGRADED (alerta de processo) e valor nulo.
 */
const money = require('./money');
const { degraded, incomplete, sortedById, total } = require('./_obraKpi');
const { daysBetween } = require('./_dates');

function oldestAge(projects, asOfDate) {
  const dates = projects.map((p) => p.oldestPendingSince).filter(Boolean).sort();
  return dates.length ? String(daysBetween(dates[0], asOfDate)) : null;
}

function compute(input) {
  const projects = sortedById(input.projects);
  if (!projects.length) return incomplete('SEM_OBRA', { projects: '0' });
  const noPayment = money.count(total(projects, (p) => p.approvedWithoutPayment || 0));
  if (noPayment !== '0') return degraded('MEDICAO_APROVADA_SEM_LANCAMENTO', { approvedWithoutPayment: noPayment, projects: String(projects.length) });
  const measured = total(projects, (p) => p.measured);
  const approved = total(projects, (p) => p.approved);
  const pending = money.sub(measured, approved);
  const age = oldestAge(projects, input.asOfDate);
  const dimensions = [{ key: 'aprovado_brl', value: money.money(approved) }, { key: 'pendente_brl', value: money.money(pending) }];
  if (age !== null) dimensions.push({ key: 'pendente_mais_antiga_dias', value: age });
  for (const p of projects) {
    dimensions.push(
      { key: `obra:${p.id}`, value: money.money(p.measured) }, { key: `obra:${p.id}:aprovado_brl`, value: money.money(p.approved) },
      { key: `obra:${p.id}:pendente_brl`, value: money.money(money.sub(p.measured, p.approved)) }
    );
  }
  return {
    value: money.money(measured), status: 'OK',
    details: { measuredBrl: money.money(measured), approvedBrl: dimensions[0].value, pendingBrl: dimensions[1].value, oldestPendingAgeDays: age, projects: String(projects.length) }, dimensions,
  };
}

const project = (id, measured, approved, oldestPendingSince = null, approvedWithoutPayment = 0) => ({ id, measured, approved, oldestPendingSince, approvedWithoutPayment });
const input = (projects) => ({ asOfDate: '2026-10-28', projects });
const per = (list) => list.flatMap(([id, m, a, p]) => [{ key: `obra:${id}`, value: m }, { key: `obra:${id}:aprovado_brl`, value: a }, { key: `obra:${id}:pendente_brl`, value: p }]);
const ok = (measured, approved, pending, age, projects, rows) => ({
  value: measured, status: 'OK', details: { measuredBrl: measured, approvedBrl: approved, pendingBrl: pending, oldestPendingAgeDays: age, projects },
  dimensions: [{ key: 'aprovado_brl', value: approved }, { key: 'pendente_brl', value: pending }, ...(age === null ? [] : [{ key: 'pendente_mais_antiga_dias', value: age }]), ...per(rows)],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma obra: INCOMPLETE e sem valor', input: input([]), expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_OBRA', projects: '0' }, dimensions: [] } },
  { kind: 'single', name: 'uma obra sem medição: tudo zero e sem idade', input: input([project('a', '0.00', '0.00')]), expected: ok('0.00', '0.00', '0.00', null, '1', [['a', '0.00', '0.00', '0.00']]) },
  {
    kind: 'typical', name: 'exemplo do livro: medido 220.000,00, aprovado 180.000,00, pendente 40.000,00 há 23 dias', input: input([project('a', '220000.00', '180000.00', '2026-10-05')]),
    expected: ok('220000.00', '180000.00', '40000.00', '23', '1', [['a', '220000.00', '180000.00', '40000.00']]),
  },
  {
    kind: 'period_edge', name: 'medição aprovada sem lançamento de pagamento previsto: DEGRADED e sem valor', input: input([project('a', '100.00', '100.00', null, 2)]),
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'MEDICAO_APROVADA_SEM_LANCAMENTO', approvedWithoutPayment: '2', projects: '1' }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'pendente enviada hoje tem idade 0 e vale a mais antiga entre as obras', input: input([project('a', '10.00', '0.00', '2026-10-28'), project('b', '10.00', '0.00', '2026-10-20')]),
    expected: ok('20.00', '0.00', '20.00', '8', '2', [['a', '10.00', '0.00', '10.00'], ['b', '10.00', '0.00', '10.00']]),
  },
  { kind: 'rounding', name: 'os totais arredondam uma só vez (0,005 + 0,005 = 0,01)', input: input([project('a', '0.005', '0.000'), project('b', '0.005', '0.000')]), expected: ok('0.01', '0.00', '0.01', null, '2', [['a', '0.01', '0.00', '0.01'], ['b', '0.01', '0.00', '0.01']]) },
];

module.exports = { id: 'obra.measurements', version: 1, compute, testCases };
