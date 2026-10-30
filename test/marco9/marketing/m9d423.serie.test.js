'use strict';

// M9-D423 — a série de lembretes: regra de dias do tick, oito lembretes, expiração com tarefa ao responsável, parâmetros e idempotência do dia.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const r = require('../_helpers/mktRestricao');

let tenant;
before(async () => { ({ tenantA: tenant } = await r.prepararTenants()); });
after(async () => { await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const OPEN_DAY = '2026-11-01';

async function setup(t) {
  await r.install(t, tenant);
  const person = await r.person(t, tenant);
  const ref = await r.openPending(t, tenant, person);
  return { person, ref };
}

/** Passa o tick de cada dia de `from` a `to` (dias depois da abertura) e devolve { dia: runs criadas }. */
async function scan(t, from, to) {
  const out = {};
  for (let day = from; day <= to; day += 1) out[day] = (await r.tick(t, tenant, r.addDays(OPEN_DAY, day))).created;
  return out;
}

test('tick_so_cria_run_no_multiplo_do_intervalo_e_na_expiracao: dias 7, 14, ..., 56 criam lembrete, o dia 60 a expiração, o 61 nada', async () => {
  await inTx(async (t) => {
    await setup(t);
    const created = await scan(t, 1, 62);
    const expected = {};
    for (let day = 1; day <= 62; day += 1) expected[day] = [7, 14, 21, 28, 35, 42, 49, 56, 60].includes(day) ? 1 : 0;
    assert.deepEqual(created, expected);
  });
});

test('lembretes_a_cada_7_dias_ate_expirar: oito lembretes de 08/11 a 27/12 e a série expira em 31/12', async () => {
  await inTx(async (t) => {
    const { person } = await setup(t);
    await scan(t, 1, 62);
    const sent = await r.sentOn(t, person);
    assert.equal(sent.length, 8);
    const dayOf = (run) => run.trigger_event_id.split(':').pop();
    const runs = (await r.runsOfPerson(t, person)).filter((run) => run.flow_code === 'RESTRICAO-LEMBRETE').sort((a, b) => dayOf(a).localeCompare(dayOf(b)));
    assert.deepEqual(runs.map((run) => run.trigger_event_id.split(':').pop()), ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27']);
    assert.ok(runs.every((run) => run.status === 'COMPLETED' && run.actions_result[0].status === 'OK' && run.actions_result[0].purpose === 'TRANSACTIONAL'));
    const expired = (await r.runsOfPerson(t, person)).filter((run) => run.flow_code === 'RESTRICAO-EXPIRACAO');
    assert.deepEqual(expired.map((run) => run.trigger_event_id.split(':').pop()), ['2026-12-31']);
  });
});

test('expiracao_cria_tarefa_ao_responsavel: run BLOCKED EXPIRED, tarefa criada ao responsável, nenhuma mensagem e a série não recomeça', async () => {
  await inTx(async (t) => {
    const { person } = await setup(t);
    await scan(t, 1, 59);
    const before = (await r.sentOn(t, person)).length;
    await r.tick(t, tenant, r.addDays(OPEN_DAY, 60));
    const [run] = (await r.runsOfPerson(t, person)).filter((x) => x.flow_code === 'RESTRICAO-EXPIRACAO');
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.blocked_reason, 'EXPIRED');
    assert.equal(run.actions_result[0].type, 'CREATE_TASK');
    assert.equal(run.actions_result[0].status, 'OK');
    const [task] = await r.q(t, 'SELECT title, assigned_to_user_id FROM core.tasks WHERE action_key = :k', { k: run.actions_result[0].action_key });
    assert.equal(task.title, 'Pendência sem resolução');
    assert.equal(task.assigned_to_user_id, tenant.userId);
    assert.equal((await r.sentOn(t, person)).length, before, 'nenhuma mensagem na expiração');
    assert.deepEqual((await r.events(t, run.id)).map((e) => e.event_type), ['automation.run.started', 'automation.run.blocked']);
    const later = await scan(t, 61, 75);
    assert.ok(Object.values(later).every((n) => n === 0), 'a run EXPIRED impede nova expiração e a condição de lembrete exige dias < expiração');
  });
});

test('intervalo_vem_de_parametro: intervalo e expiração do administrador mudam a série', async () => {
  await inTx(async (t) => {
    await upsertSetting('marketing.restricao.intervalo_dias', 10, tenant, tenant.userId, t);
    await upsertSetting('marketing.restricao.expiracao_dias', 30, tenant, tenant.userId, t);
    await setup(t);
    const created = await scan(t, 1, 32);
    assert.deepEqual(Object.entries(created).filter(([, n]) => n > 0).map(([day]) => Number(day)), [10, 20, 30]);
    await assert.rejects(upsertSetting('marketing.restricao.intervalo_dias', 0, tenant, tenant.userId, t), (e) => e.statusCode === 400);
    await assert.rejects(upsertSetting('marketing.restricao.expiracao_dias', 'sessenta', tenant, tenant.userId, t), (e) => e.statusCode === 400);
  });
});

test('o_mesmo_dia_nao_cria_duas_runs: dois ticks no mesmo dia (ou o tick repetido) criam uma run por pendência', async () => {
  await inTx(async (t) => {
    const { person } = await setup(t);
    const day = r.addDays(OPEN_DAY, 7);
    assert.equal((await r.tick(t, tenant, day)).created, 1);
    assert.equal((await r.tick(t, tenant, day)).created, 0);
    assert.equal((await r.runsOfPerson(t, person)).length, 1);
    assert.equal((await r.sentOn(t, person)).length, 1);
  });
});
