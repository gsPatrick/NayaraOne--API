'use strict';

// M9-D607 — refresh por agenda (virada do dia de São Paulo), teto de linhas por agregado e parâmetros do administrador.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env607 = require('../_helpers/m9d607Env');
const readModels = require('../../../src/features/analytics/read-models');
const { parseSchedule, REFRESH_DEFAULTS } = require('../../../src/features/analytics/read-models/readModel.settings');
const { runAnalyticsReadModelRefreshJob } = require('../../../src/engines/jobs/analyticsReadModelRefreshJob');
const { scanSource } = require('../../../scripts/lib/analyticsReadScan');
const { upsertSetting, SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { inTx, addSource, makeEvent, readRow } = env607;
let env;

let restoreModels = () => {};
before(async () => { env = await env607.setup(); restoreModels = env607.onlyOwnModelInJob(env); });
after(async () => { restoreModels(); await env607.teardown(env); }); // o job só grava no read model deste teste (os de verdade ficam intactos para os arquivos seguintes)

const inA = (fn, opts) => inTx(env.tenantA, opts || {}, fn);
const account = () => `conta-${env607.sfx()}`;

test('m9d607 job agendado recalcula vencidos na virada do dia SP', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '300.00', { settled: false, due: '2026-10-27' });
  await inA((tx) => upsertSetting('analytics.refresh.schedule', 'a cada 1000 min e às 00:05 America/Sao_Paulo', env.tenantA, env.tenantA.userId, tx), { commit: true });
  // 27/10 às 23:00 em São Paulo: o vencimento de 27/10 ainda não está vencido.
  await runAnalyticsReadModelRefreshJob({ now: new Date('2026-10-28T02:00:00Z'), force: true });
  assert.equal((await readRow(env, env.tenantA, acc)).overdue_count, 0);
  // 00:04 do dia 28: fora da agenda (intervalo de 1000 min e a virada só às 00:05): nada é recalculado.
  const idle = await runAnalyticsReadModelRefreshJob({ now: new Date('2026-10-28T03:04:00Z') });
  assert.equal((await readRow(env, env.tenantA, acc)).overdue_count, 0);
  assert.equal(idle.errors, 0);
  // 00:06 do dia 28: virou o dia de SP, o vencimento de 27/10 passou a estar vencido sem nenhum evento.
  await runAnalyticsReadModelRefreshJob({ now: new Date('2026-10-28T03:06:00Z') });
  const row = await readRow(env, env.tenantA, acc);
  assert.equal(row.overdue_count, 1);
  assert.equal(new Date(row.source_snapshot_at).toISOString(), '2026-10-28T03:06:00.000Z');
  const [[log]] = await env.admin.query(`SELECT count(*)::int AS n FROM analytics.read_model_refreshes WHERE read_model = :m AND "trigger" = 'SCHEDULE' AND status = 'SUCCEEDED'`, { replacements: { m: env.model } });
  assert.equal(log.n, 2, 'uma linha por passada agendada que rodou (a ociosa não grava)');
});

test('m9d607 recálculo toca só a linha do agregado e respeita o teto de linhas', async () => {
  const small = account();
  const big = account();
  const other = account();
  for (let i = 0; i < 2; i += 1) await addSource(env, env.tenantA, small, '10.00');
  for (let i = 0; i < 5; i += 1) await addSource(env, env.tenantA, big, '10.00');
  for (let i = 0; i < 30; i += 1) await addSource(env, env.tenantA, other, '1.00');
  env.reads.length = 0;
  await inA(async (tx) => {
    await upsertSetting('analytics.refresh.max_linhas_agregado', 3, env.tenantA, env.tenantA.userId, tx);
    const ok = await readModels.applyEvent(makeEvent(env, env.tenantA, small), tx);
    assert.equal(ok.upserted, 1);
    assert.deepEqual(env.reads.map((r) => r.account), [small], 'só a conta do evento foi lida na fonte');
    assert.equal(env.reads[0].limit, 3, 'o teto vem do parâmetro analytics.refresh.max_linhas_agregado');
    assert.equal(await readRow(env, env.tenantA, other), null, 'as outras contas não foram tocadas');
    const deferred = await readModels.applyEvent(makeEvent(env, env.tenantA, big), tx);
    assert.deepEqual([deferred.upserted, deferred.stale], [0, 1], 'acima do teto o refresh vai para a janela agendada');
    const [[stale]] = await tx.sequelize.query('SELECT count(*)::int AS n FROM analytics.rm_stale_aggregates WHERE read_model = :m AND company_id = :c', { replacements: { m: env.model, c: env.tenantA.companyId }, transaction: tx });
    assert.equal(stale.n, 1, 'agregado marcado STALE');
    assert.ok(env.reads.every((r) => r.rows <= 4), 'nunca leu mais que teto + 1 linha por evento');
    // A janela agendada recalcula o agregado adiado (sem teto) e limpa a marca.
    const params = await readModels.readRefreshParams(env.tenantA, tx);
    const done = await readModels.refreshCompanyScheduled(env.tenantA, params, tx, { now: new Date('2026-10-28T12:00:00Z') });
    assert.ok(done.find((r) => r.readModel === env.model).rows >= 1, 'o agregado adiado foi recalculado na janela agendada');
    const [[after1]] = await tx.sequelize.query(`SELECT balance::text AS b FROM analytics.${env.model} WHERE account_id = :a`, { replacements: { a: big }, transaction: tx });
    assert.equal(after1.b, '50.00');
    const [[stale2]] = await tx.sequelize.query('SELECT count(*)::int AS n FROM analytics.rm_stale_aggregates WHERE read_model = :m AND company_id = :c', { replacements: { m: env.model, c: env.tenantA.companyId }, transaction: tx });
    assert.equal(stale2.n, 0);
  });
});

test('m9d607 parâmetros do administrador: dicionário, validação e padrões do livro', async () => {
  for (const key of ['max_linhas_agregado', 'lote_segundos', 'lote_linhas', 'schedule', 'timeout_ms']) assert.ok(SETTINGS_SCHEMA[`analytics.refresh.${key}`], key);
  assert.deepEqual([REFRESH_DEFAULTS['analytics.refresh.max_linhas_agregado'], REFRESH_DEFAULTS['analytics.refresh.lote_segundos']], [10000, 30]);
  assert.deepEqual(parseSchedule(REFRESH_DEFAULTS['analytics.refresh.schedule']), { everyMinutes: 15, dailyAt: '00:05', minutesOfDay: 5, timezone: 'America/Sao_Paulo' });
  assert.equal(parseSchedule('de vez em quando'), null);
  assert.equal(parseSchedule('a cada 15 min e às 25:00 America/Sao_Paulo'), null);
  assert.equal(parseSchedule('a cada 15 min e às 00:05 Mars/Olympus'), null);
  await inA(async (tx) => {
    await assert.rejects(upsertSetting('analytics.refresh.schedule', 'amanhã', env.tenantA, env.tenantA.userId, tx), (e) => e.code === 'SETTING_INVALID_VALUE');
  });
});

test('m9d607 decisão da agenda: a cada N minutos e uma vez na virada do dia', () => {
  const schedule = parseSchedule(REFRESH_DEFAULTS['analytics.refresh.schedule']);
  const t = (iso) => new Date(iso);
  assert.equal(readModels.scheduleDue(t('2026-10-28T12:00:00Z'), schedule, {}).reason, 'FIRST');
  const first = readModels.scheduleDue(t('2026-10-28T12:00:00Z'), schedule, {});
  const state = readModels.afterRun(t('2026-10-28T12:00:00Z'), schedule, first.local);
  assert.equal(readModels.scheduleDue(t('2026-10-28T12:10:00Z'), schedule, state).due, false);
  assert.equal(readModels.scheduleDue(t('2026-10-28T12:15:00Z'), schedule, state).reason, 'INTERVAL');
  const night = readModels.afterRun(t('2026-10-28T02:50:00Z'), schedule, readModels.scheduleDue(t('2026-10-28T02:50:00Z'), schedule, state).local);
  assert.equal(readModels.scheduleDue(t('2026-10-28T03:06:00Z'), schedule, { ...night, lastRunAt: t('2026-10-28T03:00:00Z') }).reason, 'DAILY');
});

test('m9d607 varredura de segurança do BI: tabelas de controle do worker não são read model, read model continua exigindo segurança', () => {
  const control = "q('INSERT INTO analytics.rm_applied_events (x) VALUES (1) -- analytics.rm_stale_aggregates')";
  assert.deepEqual(scanSource('src/features/analytics/read-models/readModel.worker.js', control), []);
  assert.equal(scanSource('src/features/analytics/read-models/readModel.worker.js', "q('SELECT 1 FROM analytics.rm_finance_cash')").map((v) => v.rule).join(), 'R2');
});
