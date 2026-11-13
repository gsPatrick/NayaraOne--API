'use strict';

// M9-D420 B — Sem retorno: agenda diária às 09:00, cadência 1/3/7 dias por parâmetro, acompanhamento como ACOMPANHAMENTO e fim da cadência com a resposta do cliente.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d420.cadencia.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktLeads');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

const CODE = 'LEAD-SEM-RETORNO';
const inRollback = (fn) => env.withRollbackTenantTransaction(A, fn);
/** 09:00 em São Paulo (UTC-3) do dia informado. */
const at9 = (day) => new Date(`${day}T12:00:00.000Z`);
/** Primeiro contato da equipe sem resposta: 01/11 às 12:00 em São Paulo. */
const FIRST_CONTACT = new Date('2026-11-01T15:00:00.000Z');

async function tick(t, personId, day) {
  const out = await env.runner.runScheduleTick(A, t, { now: at9(day), mode: 'SANDBOX' });
  await env.retime(t, personId, at9(day));
  return out;
}
const sentOn = async (t, personId) => (await env.outbound(t, personId)).filter((m) => m.purpose === 'ACOMPANHAMENTO');
const runsOf = (t, personId) => env.q(t, 'SELECT * FROM marketing.automation_runs WHERE subject_id = :p ORDER BY created_at', { p: personId });

async function silentLead(t, over = {}) {
  await env.install(t, A, CODE);
  const lead = await env.lead(t, A, { source: 'FORM', ...over });
  await env.contact(t, A, lead.personId, FIRST_CONTACT, 'OUTBOUND');
  return lead;
}

test('sem_retorno_segue_cadencia_configuravel', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
    const sent = [];
    for (const day of days) {
      await tick(t, lead.personId, day);
      sent.push((await sentOn(t, lead.personId)).length);
    }
    assert.deepEqual(sent, [1, 1, 2, 2, 2, 2, 3, 3], 'mensagem nos dias 1, 3 e 7; nenhuma no dia 8 (fim da cadência)');
    const messages = await sentOn(t, lead.personId);
    assert.ok(messages.every((m) => m.status === 'SENT' && m.purpose === 'ACOMPANHAMENTO'), 'finalidade ACOMPANHAMENTO: o lead não precisa de OPT_IN');
    assert.ok(messages[0].body.includes('Ana'), 'a mensagem leva o primeiro nome');
    assert.notEqual(messages[0].body, messages[1].body, 'uma mensagem por etapa');
  });
});

test('a_cadencia_vem_do_parametro_sem_nova_versao', async () => {
  await inRollback(async (t) => {
    await env.setParam(t, A, 'marketing.cadencia.sem_retorno_dias', '[2,5]');
    const lead = await silentLead(t);
    const sent = [];
    for (const day of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06', '2026-11-07']) {
      await tick(t, lead.personId, day);
      sent.push((await sentOn(t, lead.personId)).length);
    }
    assert.deepEqual(sent, [0, 1, 1, 2, 2], 'dias 2 e 5 do parâmetro');
  });
});

test('resposta_encerra_cadencia', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await tick(t, lead.personId, '2026-11-02');
    assert.equal((await sentOn(t, lead.personId)).length, 1);
    await env.contact(t, A, lead.personId, new Date('2026-11-03T14:00:00.000Z'), 'INBOUND'); // Ana respondeu em 03/11
    for (const day of ['2026-11-03', '2026-11-04', '2026-11-08', '2026-11-09']) await tick(t, lead.personId, day);
    assert.equal((await sentOn(t, lead.personId)).length, 1, 'cessa tudo: nenhuma mensagem depois da resposta');
    assert.equal((await runsOf(t, lead.personId)).length, 1);
  });
});

test('oportunidade_encerrada_nao_recebe_acompanhamento', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await env.q(t, "UPDATE crm.opportunities SET stage = 'LOST' WHERE id = :id RETURNING id", { id: lead.opportunityId });
    await tick(t, lead.personId, '2026-11-02');
    assert.equal((await sentOn(t, lead.personId)).length, 0);
  });
});

test('acompanhamento_respeita_supressao_e_nao_exige_opt_in', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await env.optOut(t, A, lead.personId, 'EMAIL');
    await tick(t, lead.personId, '2026-11-02');
    assert.equal((await sentOn(t, lead.personId)).length, 0, 'quem pediu para não receber não recebe');
    const [run] = await runsOf(t, lead.personId);
    assert.equal(run.blocked_reason, 'SUPPRESSED');
  });
});

test('a_automacao_so_dispara_as_09h_do_fuso_da_empresa', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    const early = await env.runner.runScheduleTick(A, t, { now: new Date('2026-11-02T11:59:00.000Z'), mode: 'SANDBOX' }); // 08:59 em São Paulo
    assert.equal(early.created, 0);
    const exact = await env.runner.runScheduleTick(A, t, { now: new Date('2026-11-02T12:00:30.000Z'), mode: 'SANDBOX' });
    assert.equal(exact.created, 1);
    assert.equal((await sentOn(t, lead.personId)).length, 1);
    const [version] = await env.q(t, "SELECT v.trigger_config, v.risk_level, v.cooldown, v.frequency_cap FROM marketing.automation_flows f JOIN marketing.automation_versions v ON v.id = f.published_version_id WHERE f.code = :c", { c: CODE });
    assert.equal(version.trigger_config.cron, '0 9 * * *');
    assert.equal(version.risk_level, 'MEDIUM');
    assert.deepEqual(version.cooldown, { amount: 1, unit: 'DAYS' });
  });
});

test('mesma_janela_duas_vezes_nao_repete_o_acompanhamento', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await env.runner.runScheduleTick(A, t, { now: at9('2026-11-02'), mode: 'SANDBOX' });
    await env.runner.runScheduleTick(A, t, { now: new Date(at9('2026-11-02').getTime() + 20000), mode: 'SANDBOX' });
    assert.equal((await sentOn(t, lead.personId)).length, 1);
  });
});
