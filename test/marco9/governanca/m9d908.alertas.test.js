'use strict';

// M9-D908 §3.5 e critérios recebidos: janela de comparação vencida alerta o A de PARALLEL_COMPARE_CLOSE, RACI incompleta trava o canary no ensaio e o GO só vale com a simulação
// de rollback feita no DRY3 (pré-requisito registrado em rollback/readiness). Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d908Dry');
const { alertOverdueWindows } = require('../../../src/features/migration-v2/alerts/window.overdue');
const { runParallelCompare } = require('../../../src/features/migration-v2/parallel/parallel.job');

let A;
env.dry.install(); // o blocker do relógio na Torre é registrado pelo install(), como nas rotas
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

/** Avanço direto pelo serviço, sem o ajuste de RACI que o helper do canary faz. */
const rawAdvance = (sector, body) => env.openTenantTx(A, (tx) => env.canary.advance(env.tenantOf(A), sector, body, tx));
const DAY = 24 * 3600 * 1000;
const END = new Date('2030-03-01T12:00:00Z');
/** Janela RUNNING que terminou em END (inserida como o job a deixaria). */
async function runningWindow(status = 'RUNNING') {
  const [row] = (await env.adminQuery(
    `INSERT INTO governance.parallel_windows (group_id, company_id, name, source_system, starts_at, ends_at, entities, interval_min, status)
     VALUES ($1, $2, 'QA-M9 vencida', 'QA908SYS', $3, $4, '["PERSON"]'::jsonb, 60, $5) RETURNING id`,
    [A.groupId, A.companyId, new Date(END.getTime() - DAY), END, status]
  )).rows;
  return row.id;
}
const alertsFor = async (userId) => (await env.adminQuery("SELECT title, body FROM core.notifications WHERE user_id = $1 AND title LIKE 'CRÍTICO: janela de comparação%'", [userId])).rows;
const keyCount = async () => Number((await env.adminQuery('SELECT count(*) AS n FROM governance.mig_alert_log WHERE company_id = $1', [A.companyId])).rows[0].n);

test('m9d908 janela de comparação RUNNING além do prazo gera alerta CRITICAL ao A de PARALLEL_COMPARE_CLOSE', { skip: skip() }, async () => {
  const accountable = await env.committedUser(A);
  const responsible = await env.committedUser(A);
  await env.setRaci(A, 'PARALLEL_COMPARE_CLOSE', [{ userId: accountable.id, raci: 'A' }, { userId: responsible.id, raci: 'R' }]);
  const windowId = await runningWindow();
  const tenant = env.tenantOf(A);
  // dentro do prazo de 7 dias (padrão): nada
  assert.deepEqual(await alertOverdueWindows(tenant, { now: new Date(END.getTime() + 6 * DAY) }), []);
  assert.equal((await alertsFor(accountable.id)).length, 0);
  // além do prazo: alerta CRÍTICO só ao A, não ao R
  const sent = await alertOverdueWindows(tenant, { now: new Date(END.getTime() + 8 * DAY) });
  assert.deepEqual(sent, [{ windowId, recipients: [accountable.id] }]);
  const alerts = await alertsFor(accountable.id);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /^CRÍTICO: /);
  assert.match(alerts[0].body, /PARALLEL_COMPARE_CLOSE/);
  assert.equal((await alertsFor(responsible.id)).length, 0);
  // o mesmo dia não duplica; o dia seguinte lembra de novo
  assert.deepEqual(await alertOverdueWindows(tenant, { now: new Date(END.getTime() + 8 * DAY + 3600000) }), []);
  assert.equal(await keyCount(), 1);
  assert.equal((await alertOverdueWindows(tenant, { now: new Date(END.getTime() + 9 * DAY) })).length, 1);
  assert.equal((await alertsFor(accountable.id)).length, 2);
  // janela fechada não alerta
  await env.adminQuery("UPDATE governance.parallel_windows SET status = 'CLOSED' WHERE id = $1", [windowId]);
  assert.deepEqual(await alertOverdueWindows(tenant, { now: new Date(END.getTime() + 30 * DAY) }), []);
});

test('m9d908 o prazo do alerta é o parâmetro migracao.paralelo.prazo_dias e o job da comparação o executa', { skip: skip() }, async () => {
  const accountable = await env.committedUser(A);
  await env.setRaci(A, 'PARALLEL_COMPARE_CLOSE', [{ userId: accountable.id, raci: 'A' }, { role: 'GESTOR', raci: 'R' }]);
  const windowId = await runningWindow();
  // uma execução em andamento mantém a janela aberta nesta volta do job (o job só a fecha sem diferença e sem execução ocupada)
  await env.adminQuery("INSERT INTO governance.parallel_runs (group_id, company_id, window_id, run_number, status, started_at) VALUES ($1, $2, $3, 1, 'RUNNING', $4)", [A.groupId, A.companyId, windowId, new Date(END.getTime() + 3 * DAY)]);
  const tenant = env.tenantOf(A);
  await env.setParam(A, 'migracao.paralelo.prazo_dias', 2);
  assert.deepEqual(await alertOverdueWindows(tenant, { now: new Date(END.getTime() + 1 * DAY) }), [], '1 dia: dentro do prazo de 2');
  // pelo job da comparação (o mesmo que roda a cada minuto)
  const job = await runParallelCompare(tenant, { now: new Date(END.getTime() + 3 * DAY) });
  assert.equal(job.alerts, 1);
  assert.equal((await alertsFor(accountable.id)).length, 1);
});

test('m9d908 sem A utilizável o alerta vai aos administradores ativos e sem ninguém não se reserva', { skip: skip() }, async () => {
  await runningWindow();
  const now = new Date(END.getTime() + 10 * DAY);
  assert.deepEqual(await alertOverdueWindows(env.tenantOf(A), { now }), [], 'sem A e sem administrador ninguém é avisado');
  assert.equal(await keyCount(), 0, 'o alerta não foi reservado: a próxima volta tenta de novo');
  const admin = await env.openTenantTx(A, (tx) => env.newUser(A, tx, { roleName: 'ADMIN' }));
  const sent = await alertOverdueWindows(env.tenantOf(A), { now });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].recipients.includes(admin.id));
  await env.adminQuery('DELETE FROM core.user_memberships WHERE user_id = $1', [admin.id]);
  await env.adminQuery('DELETE FROM core.notifications WHERE user_id = $1', [admin.id]);
});

test('m9d908 RACI incompleta bloqueia o avanço do canary no ensaio', { skip: skip() }, async () => {
  await env.isolate(A);
  assert.ok((await env.towerCodes(A)).includes('GOV_MIG_RACI_INCOMPLETE'), 'a Torre mostra o blocker da RACI');
  const refused = await env.fail(rawAdvance('ATENDIMENTO', { percent: 5 }));
  assert.deepEqual([refused.status, refused.code], [409, 'GOV_CANARY_BLOCKERS_OPEN']);
  assert.ok(refused.details.blockers.some((b) => b.code === 'GOV_MIG_RACI_INCOMPLETE'));
  assert.equal(await env.percentOf(A, 'ATENDIMENTO'), 0, 'o setor não avançou');
  await env.completeRaci(A);
  await env.setParam(A, 'migracao.canary.exigir_comparacao', false); // as entidades da migração real não têm fonte ativa neste teste: sem janela a comparar
  const advanced = await rawAdvance('ATENDIMENTO', { percent: 5 });
  assert.equal(advanced.percent, 5, 'RACI completa libera o avanço');
  await env.rollback(A, 'ATENDIMENTO', { reason: 'QA-M9 limpeza' });
  // relógio fora do limite também trava o avanço de todos os setores
  const state = { offsetMs: 9000 };
  const off = env.fakeClockReader('QA908_SRC', 'SOURCE:QA908', state);
  try {
    await env.checkClock(A);
    const drift = await env.fail(rawAdvance('LOCACAO', { percent: 5 }));
    assert.deepEqual([drift.status, drift.code], [409, 'GOV_CANARY_BLOCKERS_OPEN']);
    assert.ok(drift.details.blockers.some((b) => b.code === 'GOV_MIG_CLOCK_DRIFT'));
  } finally { off(); }
});

test('m9d908 o GO só vale com a simulação de rollback executada no DRY3', { skip: skip() }, async () => {
  process.env.MIGRATION_DRY3_REPORT_PATH = '/nao/existe/dry3-report.json'; // sem relatório exportado (o ajudante só cria um verde quando não há caminho)
  const none = await env.fail(env.decide(A, 'GO'));
  assert.deepEqual([none.status, none.code], [409, 'GOV_CUTOVER_NOT_READY']);
  assert.ok(none.details.gaps.some((g) => g.code === 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED' && g.detail.reportId === null), 'lacuna { code, detail } sem nenhum relatório exportado');
  // ensaio concluído, mas com a simulação de rollback vermelha: continua recusado
  await env.markRollbackSimulated(A, false);
  const red = await env.fail(env.decide(A, 'GO'));
  assert.equal(red.code, 'GOV_CUTOVER_NOT_READY');
  assert.ok(red.details.gaps.some((g) => g.code === 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED' && g.detail.reportId));
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId])).rows[0].n, 0, 'nenhuma decisão foi gravada');
  // o ensaio de verdade, com a simulação concluída, libera o GO e define T0
  const s = await env.scenario(A);
  try {
    const report = await env.runDry3(A);
    assert.equal(report.criteria.rollback_simulated.ok, true);
    const go = await env.decide(A, 'GO');
    assert.ok(go.t0, 'GO aceito depois do DRY3');
  } finally { s.dispose(); }
});
