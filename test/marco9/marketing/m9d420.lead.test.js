'use strict';

// M9-D420 A — Lead novo: confirmação no canal de origem + tarefa ao corretor da carteira, pela automação pronta LEAD-NOVO.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d420.lead.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktLeads');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

const CODE = 'LEAD-NOVO';
const inRollback = (fn) => env.withRollbackTenantTransaction(A, fn);
const taskOf = (t, personId) => env.tasksOf(t, A, personId).then((rows) => rows.find((r) => r.title === 'Contatar lead novo'));

test('lead_novo_envia_confirmacao_e_cria_tarefa', async () => {
  await inRollback(async (t) => {
    const owner = await env.broker(t, A);
    await env.install(t, A, CODE);
    const lead = await env.lead(t, A, { name: 'Ana Souza', source: 'FORM', owner });
    const out = await env.run(t, A, env.leadEvent(A, lead));
    assert.equal(out.runs.length, 1);
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'COMPLETED');
    const send = env.sendEntry(row);
    assert.equal(send.status, 'OK');
    assert.equal(send.purpose, 'TRANSACTIONAL', 'a pessoa iniciou o contato: confirmação transacional');
    const [message] = await env.outbound(t, lead.personId);
    assert.equal(message.status, 'SENT');
    assert.ok(message.body.includes('Recebemos seu interesse, Ana. Em breve um corretor falará com você.'), 'o texto da confirmação, com o primeiro nome');
    const task = await taskOf(t, lead.personId);
    assert.ok(task, 'a tarefa existe');
    assert.equal(task.assigned_to_user_id, owner, 'tarefa ao responsável da carteira');
    assert.equal(task.priority, 'HIGH');
    assert.equal(new Date(task.due_at).getTime(), env.NOON_SP.getTime() + 60 * 60000, 'prazo do parâmetro (60 min)');
  });
});

test('lead_novo_sai_no_canal_de_origem', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const lead = await env.lead(t, A, { source: 'WHATSAPP', phone: true, email: true });
    await env.openWindow(t, A, lead.personId); // o lead escreveu pelo WhatsApp: janela de atendimento aberta
    const out = await env.run(t, A, env.leadEvent(A, lead));
    const send = env.sendEntry(await env.runRow(t, out.runs[0].runId));
    assert.equal(send.channel, 'WHATSAPP');
    assert.equal(send.status, 'OK');
  });
});

test('prazo_da_tarefa_vem_do_parametro_da_empresa', async () => {
  await inRollback(async (t) => {
    await env.setParam(t, A, 'marketing.lead_novo.prazo_contato_min', 15);
    await env.install(t, A, CODE);
    const lead = await env.lead(t, A, {});
    await env.run(t, A, env.leadEvent(A, lead));
    const task = await taskOf(t, lead.personId);
    assert.equal(new Date(task.due_at).getTime(), env.NOON_SP.getTime() + 15 * 60000);
  });
});

test('lead_novo_em_quiet_hours_cria_tarefa_e_adia_mensagem', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const lead = await env.lead(t, A, {});
    const out = await env.run(t, A, env.leadEvent(A, lead), { now: env.NIGHT });
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'WAITING');
    assert.equal(env.sendEntry(row).status, 'SCHEDULED');
    assert.equal(new Date(env.sendEntry(row).due_at).toISOString(), env.MORNING.toISOString(), 'confirmação às 08:00');
    assert.ok(await taskOf(t, lead.personId), 'a tarefa é criada às 22:30, sem esperar');
    assert.equal((await env.outbound(t, lead.personId)).length, 0);
    await env.runner.runDueActions(A, t, { now: new Date(env.MORNING.getTime() + 5 * 60000), mode: 'SANDBOX' });
    const [sent] = await env.outbound(t, lead.personId);
    assert.equal(sent.status, 'SENT', 'enviada às 08:00 depois de novo canSend');
  });
});

test('mesmo_evento_lead_2x_uma_confirmacao', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const lead = await env.lead(t, A, {});
    const event = env.leadEvent(A, lead);
    const first = await env.run(t, A, event);
    const again = await env.run(t, A, event);
    assert.equal(again.duplicate, true, 'o mesmo evento é duplicado no inbox');
    // outro eventId para a MESMA oportunidade: a chave da run usa a oportunidade (dedupeKey da D415) e devolve replay
    const other = await env.run(t, A, env.leadEvent(A, lead, { eventId: env.uid() }));
    assert.equal(other.runs[0].replay, true);
    assert.equal(other.runs[0].runId, first.runs[0].runId);
    assert.equal((await env.outbound(t, lead.personId)).length, 1, 'uma única confirmação');
    assert.equal((await env.tasksOf(t, A, lead.personId)).filter((r) => r.title === 'Contatar lead novo').length, 1, 'uma única tarefa');
  });
});

test('lead_novo_bloqueado_por_supressao_ou_kill_switch_ainda_cria_a_tarefa', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const suppressed = await env.lead(t, A, {});
    await env.optOut(t, A, suppressed.personId, 'EMAIL');
    const out = await env.run(t, A, env.leadEvent(A, suppressed));
    let row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(env.sendEntry(row).status, 'SKIPPED');
    assert.ok(await taskOf(t, suppressed.personId), 'supressão: a tarefa existe');

    const ks = require('../_helpers/m9d425Env');
    const held = await env.lead(t, A, {});
    await ks.on(t, A, 'GLOBAL');
    const blocked = await env.run(t, A, env.leadEvent(A, held));
    row = await env.runRow(t, blocked.runs[0].runId);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'KILL_SWITCH');
    assert.equal(env.sendEntry(row).status, 'SKIPPED');
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK', 'kill switch: a tarefa interna executa');
    assert.ok(await taskOf(t, held.personId));
  });
});

test('lead_sem_canal_de_contato_bloqueia_a_run_e_cria_so_a_tarefa', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const lead = await env.lead(t, A, { email: false, phone: false });
    const out = await env.run(t, A, env.leadEvent(A, lead));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'NO_CONTACT_CHANNEL');
    assert.equal(env.sendEntry(row).status, 'SKIPPED');
    assert.ok(await taskOf(t, lead.personId), 'apenas a tarefa foi criada');
  });
});

test('origem_fora_da_lista_nao_dispara_e_a_lista_vem_de_parametro', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const phone = await env.lead(t, A, { source: 'PHONE' });
    assert.equal((await env.run(t, A, env.leadEvent(A, phone))).runs.length, 0, 'telefone não está entre formulário, site, portal e WhatsApp');
    await env.setParam(t, A, 'marketing.lead_novo.origens', 'FORM, SITE, PORTAL, WHATSAPP, PHONE');
    const out = await env.run(t, A, env.leadEvent(A, phone, { eventId: env.uid() }));
    assert.equal(out.runs.length, 1, 'a empresa incluiu telefone');
  });
});

test('cooldown_de_24h_por_pessoa_bloqueia_a_segunda_confirmacao_mas_cria_a_tarefa', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const first = await env.lead(t, A, {});
    await env.run(t, A, env.leadEvent(A, first));
    const secondOpp = await env.makeOpportunity(t, A, first.personId, {});
    await env.q(t, "UPDATE crm.opportunities SET lead_source = 'SITE' WHERE id = :id RETURNING id", { id: secondOpp });
    const out = await env.run(t, A, env.leadEvent(A, { personId: first.personId, opportunityId: secondOpp }), { now: new Date(env.NOON_SP.getTime() + 2 * env.HOUR) });
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.blocked_reason, 'COOLDOWN');
    assert.equal((await env.outbound(t, first.personId)).length, 1, 'uma confirmação por pessoa em 24 h');
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK');
  });
});

test('a_automacao_nasce_publicada_media_risco_com_owner_cooldown_e_cap', async () => {
  await inRollback(async (t) => {
    const installed = await env.install(t, A, CODE);
    assert.equal(installed.installed, true);
    assert.equal((await env.install(t, A, CODE)).installed, false, 'idempotente pelo código');
    const [row] = await env.q(t, `SELECT f.owner_user_id, f.risk_level, f.status, v.status AS vstatus, v.risk_level AS vrisk, v.cooldown, v.frequency_cap, v.conditions, v.trigger_config
      FROM marketing.automation_flows f JOIN marketing.automation_versions v ON v.id = f.published_version_id WHERE f.code = :c`, { c: CODE });
    assert.equal(row.owner_user_id, A.userId);
    assert.deepEqual([row.risk_level, row.vrisk, row.status, row.vstatus], ['MEDIUM', 'MEDIUM', 'ACTIVE', 'PUBLISHED']);
    assert.deepEqual(row.cooldown, { amount: 24, unit: 'HOURS' });
    assert.ok(row.frequency_cap && row.frequency_cap.scope === 'PERSON_CHANNEL_PURPOSE');
    assert.deepEqual(row.conditions, ['lead.has_contact_channel']);
    assert.equal(row.trigger_config.eventType, 'crm.opportunity.created');
  });
});
