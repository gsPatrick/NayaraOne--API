'use strict';

// M9-D422 — agenda do pós-chaves (3/30/90/365) e da locação (7/15/30/90/180): datas, parâmetros, canSend no dia do envio, link da pesquisa e run de 365 dias.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const cadence = require('../_helpers/mktCadencia');

let tenant;
let offVault;
before(async () => { ({ tenantA: tenant } = await cadence.prepararTenants()); offVault = cadence.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const POS = ['2026-11-13', '2026-12-10', '2027-02-08', '2027-11-10'];

async function startAgenda(t, personId, over = {}) {
  await cadence.install(t, tenant, 'POS-CHAVES');
  const delivery = await cadence.delivered(t, tenant, personId, over);
  const out = await cadence.run(t, tenant, cadence.keysEvent(tenant, personId, delivery));
  return { delivery, out, row: await cadence.runRow(t, out.runs[0].runId) };
}

test('pos_chaves_agenda_3_30_90_365: as quatro mensagens nascem SCHEDULED nas datas do livro, as 10:00, todas com finalidade POS_VENDA e action_key própria', async () => {
  await inTx(async (t) => {
    const person = await cadence.person(t, tenant);
    const { row } = await startAgenda(t, person);
    assert.equal(row.status, 'WAITING');
    assert.deepEqual(cadence.dueDates(row), POS.map(cadence.at10));
    assert.equal(new Date(row.next_due_at).toISOString(), cadence.at10(POS[0]));
    assert.ok(row.actions_result.every((a) => a.status === 'SCHEDULED' && a.purpose === 'POS_VENDA' && a.channel === 'EMAIL'), 'inclusive o marco de 3 dias');
    assert.equal(new Set(row.actions_result.map((a) => a.action_key)).size, 4);
    assert.equal((await cadence.messagesOf(t, person)).length, 0, 'nada sai na criação');
    for (const [i, day] of POS.entries()) {
      await cadence.dueAt(t, tenant, cadence.at10(day));
      assert.equal((await cadence.messagesOf(t, person)).length, i + 1);
    }
    const done = await cadence.runRow(t, row.id);
    assert.equal(done.status, 'COMPLETED');
    assert.deepEqual((await cadence.events(t, row.id)).map((e) => e.event_type), ['automation.run.started', 'automation.run.completed']);
  });
});

test('cadencia_alterada_nao_muda_agenda_existente: a nova cadencia e o novo horario valem so para entregas novas', async () => {
  await inTx(async (t) => {
    const first = await cadence.person(t, tenant);
    const { row } = await startAgenda(t, first);
    const before = cadence.dueDates(row);
    await upsertSetting('marketing.cadencia.pos_chaves_dias', '[3,45,120,365]', tenant, tenant.userId, t);
    await upsertSetting('marketing.cadencia.horario_envio', '08:30', tenant, tenant.userId, t);
    const second = await cadence.person(t, tenant);
    const delivery = await cadence.delivered(t, tenant, second);
    const out = await cadence.run(t, tenant, cadence.keysEvent(tenant, second, delivery));
    const fresh = await cadence.runRow(t, out.runs[0].runId);
    assert.deepEqual(cadence.dueDates(fresh), ['2026-11-13', '2026-12-25', '2027-03-10', '2027-11-10'].map((d) => `${d}T11:30:00.000Z`));
    assert.deepEqual(cadence.dueDates(await cadence.runRow(t, row.id)), before, 'as ações antigas ficam intactas');
  });
});

test('locacao_so_ativa_quando_politica_exige: padrao desligado, ligada gera 7/15/30/90/180 a partir do inicio do contrato', async () => {
  await inTx(async (t) => {
    await cadence.install(t, tenant, 'LOCACAO-CADENCIA');
    const person = await cadence.person(t, tenant);
    const lease = await cadence.contract(t, tenant, { type: 'LEASE_RESIDENTIAL', startsAt: '2026-12-05T15:00:00Z', personId: person, role: 'TENANT' });
    const off = await cadence.run(t, tenant, cadence.activatedEvent(tenant, lease, 'LEASE_RESIDENTIAL'));
    assert.deepEqual(off.runs, [], 'locação desligada: nenhuma run, nenhuma mensagem');
    await upsertSetting('marketing.locacao.cadencia_ativa', true, tenant, tenant.userId, t);
    const sale = await cadence.contract(t, tenant, { type: 'SALE', personId: person });
    assert.deepEqual((await cadence.run(t, tenant, cadence.activatedEvent(tenant, sale, 'SALE'))).runs, [], 'contrato de venda nunca entra na cadência de locação');
    const on = await cadence.run(t, tenant, cadence.activatedEvent(tenant, lease, 'LEASE_RESIDENTIAL'));
    const row = await cadence.runRow(t, on.runs[0].runId);
    assert.equal(row.subject_id, person, 'o runner achou a contraparte do contrato');
    assert.deepEqual(cadence.dueDates(row), ['2026-12-12', '2026-12-20', '2027-01-04', '2027-03-05', '2027-06-03'].map(cadence.at10));
    assert.ok(row.actions_result.every((a) => a.purpose === 'POS_VENDA'));
    await upsertSetting('marketing.cadencia.locacao_dias', '[5,10,20]', tenant, tenant.userId, t);
    const other = await cadence.contract(t, tenant, { type: 'LEASE', startsAt: '2026-12-05T15:00:00Z', personId: person, role: 'TENANT' });
    const short = await cadence.runRow(t, (await cadence.run(t, tenant, cadence.activatedEvent(tenant, other, 'LEASE'))).runs[0].runId);
    assert.deepEqual(cadence.dueDates(short).slice(0, 3), ['2026-12-10', '2026-12-15', '2026-12-25'].map(cadence.at10), 'a cadência vem do parâmetro');
    assert.deepEqual(short.actions_result.slice(3).map((a) => a.error_code), ['NO_CADENCE_DAY', 'NO_CADENCE_DAY'], 'sem dia na lista a mensagem não sai');
  });
});

test('canSend_na_hora_do_envio_nao_na_criacao: sem OPT_IN na criacao a agenda nasce inteira e cada marco e avaliado no seu dia', async () => {
  await inTx(async (t) => {
    const person = await cadence.person(t, tenant, { optIn: false });
    const { row } = await startAgenda(t, person);
    assert.equal(row.status, 'WAITING');
    assert.ok(row.actions_result.every((a) => a.status === 'SCHEDULED'), 'a criação não consulta o consentimento');
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    let now = await cadence.runRow(t, row.id);
    assert.equal(now.actions_result[0].status, 'SKIPPED');
    assert.equal(now.actions_result[0].error_code, 'NO_CONSENT');
    assert.equal(now.actions_result[1].status, 'SCHEDULED', 'as demais continuam sendo avaliadas no próprio vencimento');
    await cadence.addConsent(t, tenant, person, 'EMAIL', 'POS_VENDA', 'OPT_IN', new Date('2026-12-01T12:00:00Z'));
    await cadence.dueAt(t, tenant, cadence.at10(POS[1]));
    now = await cadence.runRow(t, row.id);
    assert.equal(now.actions_result[1].status, 'OK', 'consentimento dado depois da criação vale no dia');
    assert.equal((await cadence.messagesOf(t, person)).length, 1);
  });
});

test('agenda_de_365_dias_nao_e_run_travada: a run WAITING de um ano nunca e retomada pela regra de 300 segundos', async () => {
  await inTx(async (t) => {
    const person = await cadence.person(t, tenant);
    const { row } = await startAgenda(t, person);
    const year = new Date('2027-10-01T12:00:00Z');
    assert.equal((await cadence.runner.recoverStuckRuns(tenant, t, { now: year, mode: 'SANDBOX' })).replayed, 0);
    const same = await cadence.runRow(t, row.id);
    assert.equal(same.status, 'WAITING');
    assert.deepEqual(cadence.dueDates(same), cadence.dueDates(row));
    assert.equal((await cadence.messagesOf(t, person)).length, 0);
  });
});

test('marco_de_30_dias_envia_link_da_pesquisa_do_crm_sem_criar_pesquisa: so o link vai na mensagem, nenhuma nota e gravada', async () => {
  await inTx(async (t) => {
    const person = await cadence.person(t, tenant);
    const { row } = await startAgenda(t, person);
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    await cadence.dueAt(t, tenant, cadence.at10(POS[1]));
    const [message] = (await cadence.q(t, "SELECT body FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND' ORDER BY created_at, id", { p: person })).slice(1);
    assert.ok(message.body.includes(cadence.survey), message.body);
    assert.equal((await cadence.q(t, 'SELECT count(*)::int AS n FROM marketing.review_requests WHERE person_id = :p', { p: person }))[0].n, 0, 'o Marketing não cria nem guarda a pesquisa');
    assert.equal((await cadence.runRow(t, row.id)).actions_result[1].status, 'OK');
  });
});

test('marco_de_30_dias_sem_link_configurado_nao_envia_marcador_cru', async () => {
  await inTx(async (t) => {
    const person = await cadence.person(t, tenant, { link: false });
    const { row } = await startAgenda(t, person);
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    await cadence.dueAt(t, tenant, cadence.at10(POS[1]));
    const now = await cadence.runRow(t, row.id);
    assert.equal(now.actions_result[1].status, 'SKIPPED');
    assert.equal(now.actions_result[1].error_code, 'MKT_LINK_NOT_AVAILABLE');
    assert.equal((await cadence.messagesOf(t, person)).length, 1, 'só a mensagem de 3 dias saiu');
  });
});
