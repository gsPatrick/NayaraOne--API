'use strict';

// M9-D606 — resolvedor único de período do BI no calendário de São Paulo. Funções puras, relógio injetável, sem banco.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../../../src/features/analytics/metrics/clock');
const period = require('../../../src/features/analytics/metrics/period');
const compare = require('../../../src/features/analytics/metrics/period.compare');
const calendar = require('../../../src/features/analytics/metrics/period.calendar');

afterEach(() => clock.resetClock());

const at = (iso) => clock.setClock(() => new Date(iso));
const errorOf = (fn) => { try { fn(); } catch (err) { return err; } return null; };

test('m9d606 timezone de período correto: 23:30 SP de 30/09 pertence a setembro', () => {
  const settledAt = new Date('2026-10-01T02:30:00Z'); // 23:30 de 30/09 em São Paulo
  const sep = period.resolvePeriod({ month: '2026-09' });
  const oct = period.resolvePeriod({ month: '2026-10' });
  assert.equal(calendar.instantInPeriod(settledAt, sep), true);
  assert.equal(calendar.instantInPeriod(settledAt, oct), false);
  assert.equal(calendar.businessDateOf(settledAt), '2026-09-30');
  assert.equal(sep.startInstant.toISOString(), '2026-09-01T03:00:00.000Z');
  assert.equal(sep.endInstantExclusive.toISOString(), '2026-10-01T03:00:00.000Z');
});

test('m9d606 00:10 SP de 01/10 pertence a outubro', () => {
  const settledAt = new Date('2026-10-01T03:10:00Z');
  assert.equal(calendar.instantInPeriod(settledAt, period.resolvePeriod({ month: '2026-10' })), true);
  assert.equal(calendar.instantInPeriod(settledAt, period.resolvePeriod({ month: '2026-09' })), false);
  assert.equal(calendar.instantInPeriod(new Date('2026-10-01T03:00:00Z'), period.resolvePeriod({ month: '2026-10' })), true, 'início inclusivo');
  assert.equal(calendar.instantInPeriod(new Date('2026-10-01T02:59:59.999Z'), period.resolvePeriod({ month: '2026-10' })), false, 'fim do mês anterior exclusivo');
});

test('m9d606 vencimento hoje não é vencido', () => {
  const dueAt = new Date('2026-10-27T15:00:00Z'); // meio-dia de SP, como o sistema grava
  at('2026-10-27T17:00:00Z'); // 14:00 SP
  const today = period.resolvePeriod({}).asOfDate;
  assert.equal(today, '2026-10-27');
  assert.equal(calendar.isOverdueOn(dueAt, today), false, 'vence hoje: não está vencida nem à tarde');
  assert.equal(calendar.isOverdueOn(dueAt, '2026-10-28'), true, 'vencida a partir do dia seguinte');
  assert.equal(calendar.isOverdueOn(dueAt, '2026-10-26'), false);
  assert.equal(calendar.dueDateOf(dueAt), '2026-10-27');
});

test('m9d606 fevereiro bissexto 2028 tem 29 dias', () => {
  const feb = period.resolvePeriod({ month: '2028-02' });
  assert.equal(feb.startDate, '2028-02-01');
  assert.equal(feb.endDate, '2028-02-29');
  assert.equal(feb.endInstantExclusive.toISOString(), '2028-03-01T03:00:00.000Z');
  assert.equal(period.resolvePeriod({ month: '2026-02' }).endDate, '2026-02-28');
  assert.equal(period.resolvePeriod({ month: '2026-02' }).endInstantExclusive.toISOString(), '2026-03-01T03:00:00.000Z');
  const q1 = period.resolvePeriod({ quarter: '2026-Q1' });
  assert.deepEqual([q1.startDate, q1.endDate], ['2026-01-01', '2026-03-31']);
  assert.deepEqual([period.resolvePeriod({ quarter: '2026-Q4' }).startDate, period.resolvePeriod({ quarter: '2026-Q4' }).endDate], ['2026-10-01', '2026-12-31']);
  const y = period.resolvePeriod({ year: '2026' });
  assert.deepEqual([y.startDate, y.endDate], ['2026-01-01', '2026-12-31']);
  assert.equal(y.endInstantExclusive.toISOString(), '2027-01-01T03:00:00.000Z');
  assert.equal(period.resolvePeriod({ year: 2026 }).startDate, '2026-01-01', 'ano numérico também vale');
});

test('m9d606 padrão sem parâmetros é o mês corrente de São Paulo', () => {
  at('2026-11-01T02:00:00Z'); // ainda 31/10 em SP (23:00)
  const p = period.resolvePeriod();
  assert.deepEqual([p.startDate, p.endDate, p.asOfDate], ['2026-10-01', '2026-10-31', '2026-10-31']);
  at('2026-11-01T03:00:00Z'); // virou o mês em SP
  assert.equal(period.resolvePeriod({}).startDate, '2026-11-01');
  const range = period.resolvePeriod({ from: '2026-10-10', to: '2026-10-10' });
  assert.equal(range.endInstantExclusive.getTime() - range.startInstant.getTime(), 86400000, 'um dia: [00:00, 00:00 do dia seguinte)');
  assert.ok(range.label && typeof range.label === 'string');
});

test('m9d606 from maior que to é recusado', () => {
  for (const input of [{ from: '2026-10-10', to: '2026-10-01' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-01' }, { to: '2026-10-01' },
    { month: '2026-13' }, { month: '2026-9' }, { quarter: '2026-Q5' }, { year: '26' }, { from: 'ontem', to: 'hoje' }, { month: '2026-09', year: '2026' }, { tz: 'UTC' }]) {
    const err = errorOf(() => period.resolvePeriod(input));
    assert.ok(err, `deveria recusar ${JSON.stringify(input)}`);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'ANALYTICS_PERIOD_INVALID');
    assert.equal(err.message, 'Período inválido. Informe from/to em datas de calendário (AAAA-MM-DD), com início menor ou igual ao fim.');
  }
});

test('m9d606 asOf posterior a hoje é recusado', () => {
  at('2026-10-27T17:00:00Z');
  const err = errorOf(() => period.resolvePeriod({ asOf: '2026-10-28' }));
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, 'ANALYTICS_AS_OF_FUTURE');
  assert.equal(err.message, 'A data-base não pode estar no futuro.');
  assert.equal(period.resolvePeriod({ asOf: '2026-10-27' }).asOfDate, '2026-10-27', 'hoje vale');
  assert.equal(period.resolvePeriod({ month: '2026-09', asOf: '2026-09-30' }).asOfDate, '2026-09-30');
  // 23:30 de SP ainda é hoje em SP mesmo sendo o dia seguinte em UTC
  at('2026-10-28T02:30:00Z');
  assert.equal(period.resolvePeriod({ asOf: '2026-10-27' }).asOfDate, '2026-10-27');
  assert.equal(errorOf(() => period.resolvePeriod({ asOf: '2026-10-28' })).code, 'ANALYTICS_AS_OF_FUTURE');
  assert.equal(errorOf(() => period.resolvePeriod({ asOf: '2026-02-30' })).code, 'ANALYTICS_PERIOD_INVALID');
  assert.equal(period.resolveAsOf(undefined), '2026-10-27');
  assert.equal(errorOf(() => period.resolveAsOf('2026-10-29')).code, 'ANALYTICS_AS_OF_FUTURE');
});

test('m9d606 período anterior de mesma duração', () => {
  const p = period.resolvePeriod({ from: '2026-10-10', to: '2026-10-19' }); // 10 dias
  const prev = compare.previousPeriod(p);
  assert.deepEqual([prev.startDate, prev.endDate], ['2026-09-30', '2026-10-09']);
  assert.equal(prev.endInstantExclusive.getTime(), p.startInstant.getTime(), 'termina exatamente onde o atual começa: [início − duração, início)');
  assert.equal(prev.endInstantExclusive.getTime() - prev.startInstant.getTime(), p.endInstantExclusive.getTime() - p.startInstant.getTime());
  const one = compare.previousPeriod(period.resolvePeriod({ from: '2026-03-01', to: '2026-03-01' }));
  assert.deepEqual([one.startDate, one.endDate], ['2026-02-28', '2026-02-28']);
});

test('m9d606 mês contra mês anterior usa meses de calendário', () => {
  const mar = compare.previousPeriod(period.resolvePeriod({ month: '2026-03' }));
  assert.deepEqual([mar.startDate, mar.endDate], ['2026-02-01', '2026-02-28'], 'fevereiro inteiro (28 dias), não 31 dias antes de 1º de março');
  const jan = compare.previousPeriod(period.resolvePeriod({ month: '2026-01' }));
  assert.deepEqual([jan.startDate, jan.endDate], ['2025-12-01', '2025-12-31']);
  const mar2028 = compare.previousPeriod(period.resolvePeriod({ month: '2028-03' }));
  assert.equal(mar2028.endDate, '2028-02-29');
  const q = compare.previousPeriod(period.resolvePeriod({ quarter: '2026-Q1' }));
  assert.deepEqual([q.startDate, q.endDate], ['2025-10-01', '2025-12-31']);
  const y = compare.previousPeriod(period.resolvePeriod({ year: '2026' }));
  assert.deepEqual([y.startDate, y.endDate], ['2025-01-01', '2025-12-31']);
  assert.equal(compare.previousPeriod(period.resolvePeriod({ month: '2026-03' })).startInstant.toISOString(), '2026-02-01T03:00:00.000Z');
  assert.equal(compare.competenceMonthsOf(period.resolvePeriod({ quarter: '2026-Q3' })).join(','), '2026-07,2026-08,2026-09');
  assert.equal(compare.competenceMonthsOf(period.resolvePeriod({ month: '2026-09' }))[0], '2026-09');
});

test('m9d606 dias úteis usam o helper do projeto e o resto do BI conta dias corridos', () => {
  // sexta 23/10/2026 até segunda 26/10/2026: 3 dias corridos, 1 dia útil (segunda), fim de semana no meio
  assert.equal(calendar.calendarDaysBetween('2026-10-23', '2026-10-26'), 3);
  assert.equal(calendar.businessDaysBetween('2026-10-23', '2026-10-26'), 1);
  assert.equal(calendar.businessDaysBetween('2026-10-19', '2026-10-26'), 5, 'segunda a segunda: ter, qua, qui, sex e a segunda seguinte');
  assert.equal(calendar.businessDaysBetween('2026-10-24', '2026-10-25'), 0, 'só fim de semana');
  assert.equal(calendar.businessDaysBetween('2026-10-26', '2026-10-26'), 0);
  assert.equal(calendar.calendarDaysBetween('2026-10-26', '2026-10-23'), -3);
  const helper = require('../../../src/engines/jobs/businessDays.helper');
  const src = require('node:fs').readFileSync(require.resolve('../../../src/features/analytics/metrics/period.calendar'), 'utf8');
  assert.match(src, /businessDays\.helper/, 'reusa o helper do jurídico, sem segundo calendário');
  assert.deepEqual(helper.lastBusinessDays(new Date('2026-10-26T12:00:00Z'), 2), ['2026-10-23', '2026-10-22']);
});

test('m9d606 relógio injetável e nenhum KPI usa Date local do servidor', () => {
  at('2026-05-05T12:00:00Z');
  assert.equal(clock.now().toISOString(), '2026-05-05T12:00:00.000Z');
  clock.resetClock();
  assert.ok(Math.abs(clock.now().getTime() - Date.now()) < 5000);
  assert.equal(clock.businessToday(new Date('2026-10-01T02:30:00Z')), '2026-09-30');

  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '../../../src/features/analytics');
  const offenders = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    if (!e.name.endsWith('.js') || e.name === 'clock.js' || e.name === 'readOnly.readerRole.js') return null; // clock.js é o único relógio; o sonda do role usa TTL de cache, não data de KPI
    const text = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n'); // sem comentários
    if (/new Date\(\s*\)|Date\.now\(|\.get(Month|Date|FullYear|Day|Hours|Minutes|Seconds|TimezoneOffset)\(/.test(text)) offenders.push(path.relative(root, full));
    return null;
  });
  walk(root);
  assert.deepEqual(offenders, [], 'só clock.now() e businessDateKey; nada de Date local do servidor');
});
