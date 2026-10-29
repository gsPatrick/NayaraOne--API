'use strict';

// M9-D833 — dias úteis do prazo de conciliação (segunda a sexta, menos as datas de governanca.calendario.feriados; padrão: feriados nacionais do ano). Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const days = require('../../../src/features/core-governance/calendar/businessDays');

test('m9d833 feriados nacionais de 2026 incluem a Sexta-feira Santa calculada pela Páscoa', () => {
  assert.deepEqual(days.nationalHolidays(2026), ['2026-01-01', '2026-04-03', '2026-04-21', '2026-05-01', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']);
  assert.ok(days.nationalHolidays(2027).includes('2027-03-26'), 'Páscoa de 2027 é 28/03: Sexta-feira Santa em 26/03');
});

test('m9d833 dia útil é segunda a sexta fora dos feriados e a contagem pula fim de semana', () => {
  const none = days.holidaySet('', [2026]);
  assert.equal(days.isBusinessDay('2026-10-24', none), false, 'sábado');
  assert.equal(days.isBusinessDay('2026-10-12', none), false, 'feriado nacional padrão');
  assert.equal(days.addBusinessDays('2026-10-20', 3, none), '2026-10-23');
  assert.equal(days.addBusinessDays('2026-10-22', 3, none), '2026-10-27', 'quinta + 3 úteis = terça');
  assert.equal(days.addBusinessDays('2026-10-10', 1, none), '2026-10-13', 'sábado + 1 útil pula o feriado de segunda 12/10');
});

test('m9d833 a lista configurada substitui os feriados nacionais', () => {
  const custom = days.holidaySet('2026-10-22, 2026-12-24', [2026]);
  assert.equal(days.addBusinessDays('2026-10-20', 3, custom), '2026-10-26', 'quinta 22/10 é feriado da empresa');
  assert.equal(days.isBusinessDay('2026-10-12', custom), true, 'a lista própria não herda os nacionais');
});
