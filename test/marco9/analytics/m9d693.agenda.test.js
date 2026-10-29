'use strict';

// M9-D693 (3.1) — agenda do briefing: diário às 06:30 de São Paulo cobrindo D-1; semanal na segunda às 07:00 cobrindo a semana anterior
// (segunda a domingo, SP); horários e limites são parâmetros do administrador. Parte pura (sem banco) e leitura dos parâmetros da empresa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env693 = require('../_helpers/m9d693Env');
const briefs = require('../../../src/features/analytics/briefs');
const period = require('../../../src/features/analytics/briefs/brief.period');
const settings = require('../../../src/features/analytics/briefSettings');
const { BRIEF_SETTINGS_SCHEMA, KEYS, DEFAULTS } = settings;

let env;
before(async () => { env = await env693.setup(); });
after(async () => { await env693.teardown(env); });

const DEFAULT_PARAMS = { daily: settings.parseDaily(DEFAULTS[KEYS.daily]), weekly: settings.parseWeekly(DEFAULTS[KEYS.weekly]) };
const at = (iso) => new Date(iso);

test('m9d693 briefing diário é gerado às 06:30 SP para D-1', () => {
  // 06:29 em SP = 09:29Z; 06:30 em SP = 09:30Z (UTC-3 fixo)
  assert.equal(briefs.isBriefDue('DAILY', at('2026-10-28T09:29:00Z'), DEFAULT_PARAMS), false);
  assert.equal(briefs.isBriefDue('DAILY', at('2026-10-28T09:30:00Z'), DEFAULT_PARAMS), true);
  assert.equal(briefs.isBriefDue('DAILY', at('2026-10-28T23:59:00Z'), DEFAULT_PARAMS), true, 'passou da hora, segue devido até o fim do dia (recuperação)');
  assert.deepEqual(briefs.coveredPeriod('DAILY', at('2026-10-28T09:30:00Z')), { startDate: '2026-10-27', endDate: '2026-10-27' });
  // 23:30 de terça em SP já é quarta em UTC: o dia de São Paulo é que vale (D-1 de terça é segunda)
  assert.deepEqual(briefs.coveredPeriod('DAILY', at('2026-10-28T02:30:00Z')), { startDate: '2026-10-26', endDate: '2026-10-26' });
  assert.equal(briefs.isBriefDue('DAILY', at('2026-10-28T08:59:00Z'), DEFAULT_PARAMS), false, '05:59 de quarta em SP');
  assert.equal(briefs.isBriefDue('DAILY', at('2026-10-28T01:00:00Z'), DEFAULT_PARAMS), true, '22:00 de terça em SP: o de terça (D-1 = segunda) já passou da hora');
});

test('m9d693 semanal cobre seg-dom de SP', () => {
  assert.equal(briefs.isBriefDue('WEEKLY', at('2026-10-26T09:59:00Z'), DEFAULT_PARAMS), false, 'segunda 06:59 em SP');
  assert.equal(briefs.isBriefDue('WEEKLY', at('2026-10-26T10:00:00Z'), DEFAULT_PARAMS), true, 'segunda 07:00 em SP');
  assert.equal(briefs.isBriefDue('WEEKLY', at('2026-10-25T23:00:00Z'), DEFAULT_PARAMS), true, 'domingo à noite: a semana de 19 a 25 ainda deve o semanal de 12 a 18 (recuperação)');
  assert.deepEqual(briefs.coveredPeriod('WEEKLY', at('2026-10-25T23:00:00Z')), { startDate: '2026-10-12', endDate: '2026-10-18' });
  assert.equal(briefs.isBriefDue('WEEKLY', at('2026-10-28T09:40:00Z'), DEFAULT_PARAMS), true, 'quarta: segue devido na semana (recuperação)');
  for (const when of ['2026-10-26T10:00:00Z', '2026-10-28T09:40:00Z', '2026-11-01T20:00:00Z']) {
    const p = briefs.coveredPeriod('WEEKLY', at(when));
    assert.deepEqual(p, { startDate: '2026-10-19', endDate: '2026-10-25' }, `semana anterior vista de ${when}`);
    assert.equal(new Date(`${p.startDate}T00:00:00Z`).getUTCDay(), 1, 'começa na segunda');
    assert.equal(new Date(`${p.endDate}T00:00:00Z`).getUTCDay(), 0, 'termina no domingo');
  }
  // segunda 00:30 em SP (03:30Z) ainda cobre a semana anterior; o domingo 23:30 em SP (02:30Z de segunda) também é domingo em SP
  assert.deepEqual(briefs.coveredPeriod('WEEKLY', at('2026-10-26T02:30:00Z')), { startDate: '2026-10-12', endDate: '2026-10-18' });
  // o período anterior (base da variação) é a semana de sete dias imediatamente antes
  const { current, previous } = period.resolveBriefPeriods('WEEKLY', at('2026-10-28T09:40:00Z'));
  assert.deepEqual([current.startDate, current.endDate, previous.startDate, previous.endDate], ['2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18']);
});

test('m9d693 horários e limites do briefing são parâmetros validados do administrador', () => {
  assert.deepEqual(settings.parseDaily('07:15 America/Sao_Paulo'), { minutes: 435, text: '07:15' });
  assert.equal(settings.parseDaily('25:00'), null);
  assert.equal(settings.parseWeekly('sexta 08:00 America/Sao_Paulo').weekday, 5);
  assert.equal(settings.parseWeekly('domingo 08:00').weekday, 0);
  assert.equal(settings.parseWeekly('feriado 08:00'), null);
  assert.deepEqual(settings.parseMax('diário 5; semanal 9'), { DAILY: 5, WEEKLY: 9 });
  assert.equal(settings.parseMax('diário 0; semanal 9'), null);
  for (const [key, bad] of [[KEYS.daily, '6h30'], [KEYS.weekly, 'segunda'], [KEYS.max, 'sete'], [KEYS.domains, 'Padaria'], [KEYS.polarity, 'fin.x=meio'], [KEYS.causes, 'x']]) {
    assert.throws(() => BRIEF_SETTINGS_SCHEMA[key].validate(key, bad), (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE', key);
  }
  const monday = { daily: settings.parseDaily('06:30'), weekly: settings.parseWeekly('sexta 18:00') };
  assert.equal(briefs.isBriefDue('WEEKLY', at('2026-10-30T20:59:00Z'), monday), false, 'sexta 17:59 em SP');
  assert.equal(briefs.isBriefDue('WEEKLY', at('2026-10-30T21:00:00Z'), monday), true, 'sexta 18:00 em SP');
});

test('m9d693 a empresa troca o horário e o limite e a leitura devolve o configurado, com o padrão do livro na ausência', async () => {
  await env693.inTx(env.tenantA, {}, async (tx) => {
    const padrao = await briefs.readBriefParams(env693.scopeOf(env.tenantA), tx);
    assert.equal(padrao.daily.text, '06:30');
    assert.equal(padrao.weekly.text, 'segunda 07:00');
    assert.deepEqual(padrao.maxItems, { DAILY: 7, WEEKLY: 12 });
    assert.equal(padrao.role, 'Diretoria');
    await env693.setting(env.tenantA, tx, KEYS.daily, '08:00 America/Sao_Paulo');
    await env693.setting(env.tenantA, tx, KEYS.max, 'diário 3; semanal 4');
    await env693.setting(env.tenantA, tx, KEYS.weekly, 'texto sem sentido');
    const propria = await briefs.readBriefParams(env693.scopeOf(env.tenantA), tx);
    assert.equal(propria.daily.text, '08:00');
    assert.deepEqual(propria.maxItems, { DAILY: 3, WEEKLY: 4 });
    assert.equal(propria.weekly.text, 'segunda 07:00', 'valor inválido cai no padrão');
    // a empresa B não vê o parâmetro da A
    const outra = await env693.inTx(env.tenantB, {}, (txB) => briefs.readBriefParams(env693.scopeOf(env.tenantB), txB));
    assert.equal(outra.daily.text, '06:30');
  });
});
