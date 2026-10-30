'use strict';

// M9-D414 — bloqueios do runner: os 17 motivos, bloqueio de envio x de aplicabilidade, kill switch no passo 3, empresa errada, cap uma única vez.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');
const ks = require('../_helpers/m9d425Env');

let tenant; let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await env.prepararTenants()); });
after(async () => { await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const rows = async (t, runId) => env.runRow(t, runId);
const statuses = (row) => Object.fromEntries(row.actions_result.map((a) => [a.type, a.status]));

/** Roda o fluxo padrão (envio + tarefa) e devolve a run. `setup` prepara o cenário antes. */
async function scenario(t, { setup, flow = {}, runOptions = {}, eventOver = {} } = {}) {
  const person = await env.readyPerson(t, tenant);
  await env.q(t, "UPDATE marketing.automation_flows SET status = 'PAUSED' WHERE company_id = :c", { c: tenant.companyId }); // só o fluxo do cenário dispara
  const published = await env.publishedFlow(t, tenant, flow);
  if (setup) await setup(person, published);
  const out = await env.run(t, tenant, env.eventFor(tenant, person, eventOver), runOptions);
  const mine = out.runs.find((r) => r.flowId === published.flowId);
  return { person, published, out, row: await rows(t, mine.runId) };
}

test('bloqueio_de_envio_executa_acoes_internas: com SUPPRESSED e com KILL_SWITCH a mensagem e SKIPPED, a tarefa executa, run BLOCKED e evento blocked', async () => {
  await inTx(async (t) => {
    const suppressed = await scenario(t, { setup: (p) => env.optOut(t, tenant, p, 'WHATSAPP') });
    assert.equal(suppressed.row.status, 'BLOCKED');
    assert.match(suppressed.row.blocked_reason, /^(SUPPRESSED|OPT_OUT)$/);
    assert.deepEqual(statuses(suppressed.row), { SEND_MESSAGE: 'SKIPPED', CREATE_TASK: 'OK' });
    assert.equal(env.sendEntry(suppressed.row).error_code, suppressed.row.blocked_reason);
    assert.equal((await env.messagesOf(t, suppressed.person)).length, 0, 'zero mensagem');
    assert.deepEqual((await env.events(t, suppressed.row.id)).map((e) => e.event_type), ['automation.run.started', 'automation.run.blocked']);

    await ks.on(t, tenant, 'GLOBAL');
    const killed = await scenario(t, {});
    assert.equal(killed.row.blocked_reason, 'KILL_SWITCH');
    assert.deepEqual(statuses(killed.row), { SEND_MESSAGE: 'SKIPPED', CREATE_TASK: 'OK' });
    assert.equal((await env.messagesOf(t, killed.person)).length, 0);
    await ks.off(t, tenant, 'GLOBAL');
  });
});

test('runner_respeita_kill_switch_no_passo_3: global, canal, campanha e automacao; estado ilegivel tambem bloqueia; reativar volta a processar', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    const flow = await env.publishedFlow(t, tenant);
    const go = async () => (await env.runRow(t, (await env.run(t, tenant, env.eventFor(tenant, person), { now: new Date(env.NOON_SP.getTime() + Math.random() * 1000) })).runs[0].runId));
    await ks.on(t, tenant, 'CHANNEL', 'WHATSAPP');
    assert.equal((await go()).blocked_reason, 'KILL_SWITCH');
    await ks.off(t, tenant, 'CHANNEL', 'WHATSAPP');
    await ks.on(t, tenant, 'AUTOMATION', flow.flowId);
    const byAutomation = await go();
    assert.equal(byAutomation.blocked_reason, 'KILL_SWITCH');
    assert.equal(byAutomation.policy_trace.find((e) => e.name === 'SUPPRESSION_CONSENT').killSwitch.blocked, true);
    await ks.off(t, tenant, 'AUTOMATION', flow.flowId);
    await ks.withBrokenState(async () => assert.equal((await go()).blocked_reason, 'KILL_SWITCH'));
    assert.equal((await go()).status, 'COMPLETED', 'ao reativar, a run seguinte processa normalmente');
  });
});

test('bloqueio_de_aplicabilidade_nao_executa_nenhuma_acao: CONDITION_FALSE deixa tudo SKIPPED, sem tarefa e sem mensagem', async () => {
  await inTx(async (t) => {
    await env.publishRule(t, tenant, 'qa-m9-nunca', { fact: 'leadStage', op: '==', value: 'NUNCA_EXISTE' });
    const r = await scenario(t, { flow: { conditions: ['qa-m9-nunca'] } });
    assert.equal(r.row.status, 'BLOCKED');
    assert.equal(r.row.blocked_reason, 'CONDITION_FALSE');
    assert.deepEqual(statuses(r.row), { SEND_MESSAGE: 'SKIPPED', CREATE_TASK: 'SKIPPED' });
    assert.equal((await env.tasksByKey(t, env.entry(r.row, 'CREATE_TASK').action_key)).length, 0);
    assert.equal((await env.messagesOf(t, r.person)).length, 0);
  });
});

test('sujeito_de_outra_empresa_bloqueia: CROSS_COMPANY, nenhuma acao', async () => {
  await inTx(async (t) => {
    const foreign = await env.asTenant(t, tenant, tenantB, () => env.readyPerson(t, tenantB));
    await env.publishedFlow(t, tenant);
    const out = await env.run(t, tenant, env.eventFor(tenant, foreign));
    const row = await rows(t, out.runs[0].runId);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'CROSS_COMPANY');
    assert.deepEqual(statuses(row), { SEND_MESSAGE: 'SKIPPED', CREATE_TASK: 'SKIPPED' });
  });
});

test('run_fora_da_validade_nasce_blocked_outside_validity sem executar acao (evaluateValidity da D413)', async () => {
  await inTx(async (t) => {
    const past = await scenario(t, { flow: { validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' } });
    assert.equal(past.row.blocked_reason, 'OUTSIDE_VALIDITY');
    assert.deepEqual(statuses(past.row), { SEND_MESSAGE: 'SKIPPED', CREATE_TASK: 'SKIPPED' });
    const future = await scenario(t, { flow: { validFrom: '2027-01-01T00:00:00Z' } });
    assert.equal(future.row.blocked_reason, 'OUTSIDE_VALIDITY');
    const inside = await scenario(t, { flow: { validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' } });
    assert.equal(inside.row.status, 'COMPLETED');
  });
});

test('cada_motivo_de_bloqueio_da_lista_de_17_e_produzido: um caso por motivo; QUIET_HOURS e MKT_NO_PUBLISHED_VERSION nunca viram blocked_reason', async () => {
  const { BLOCKED_REASONS, SEND_BLOCK_REASONS, APPLICABILITY_REASONS } = env.runner;
  assert.equal(BLOCKED_REASONS.length, 17);
  assert.equal(new Set(BLOCKED_REASONS).size, 17);
  assert.deepEqual([...SEND_BLOCK_REASONS, ...APPLICABILITY_REASONS].sort(), [...BLOCKED_REASONS].sort());
  assert.ok(!BLOCKED_REASONS.includes('QUIET_HOURS') && !BLOCKED_REASONS.includes('MKT_NO_PUBLISHED_VERSION'));
  const produced = new Map();
  const note = (row) => produced.set(row.blocked_reason, row);
  await inTx(async (t) => {
    note((await scenario(t, { setup: async () => ks.on(t, tenant, 'GLOBAL') })).row); await ks.off(t, tenant, 'GLOBAL');
    note((await scenario(t, { setup: (p) => env.optOut(t, tenant, p, 'WHATSAPP') })).row);
    const noAddress = await scenario(t, { setup: (p) => env.q(t, "DELETE FROM people.person_contacts WHERE person_id = :p AND contact_type = 'WHATSAPP'", { p }) });
    produced.set('NO_ADDRESS', noAddress.row);
    const noConsent = await scenario(t, { setup: (p) => env.q(t, "DELETE FROM people.communication_consents WHERE person_id = :p", { p }) });
    produced.set('NO_CONSENT', noConsent.row);
    const policy = await scenario(t, { flow: { actions: [env.SEND({ templateId: null }), env.TASK()] } });
    produced.set('CHANNEL_POLICY', policy.row);
    const optOutConsent = await scenario(t, { setup: (p) => env.addConsent(t, tenant, p, 'WHATSAPP', 'MARKETING', 'OPT_OUT', new Date(env.NOON_SP.getTime() - 60000)) });
    produced.set('OPT_OUT', optOutConsent.row);
    const noChannel = await scenario(t, { flow: { actions: [env.SEND({ channel: 'AUTO' }), env.TASK()] }, setup: (p) => env.q(t, 'DELETE FROM people.person_contacts WHERE person_id = :p', { p }) });
    produced.set('NO_CONTACT_CHANNEL', noChannel.row);
    const expired = await scenario(t, { flow: { actions: [env.SEND({ expiresAt: '2026-11-09T16:00:00Z' }), env.TASK()] } });
    produced.set('EXPIRED', expired.row);
    const cap = await scenario(t, { flow: { frequencyCap: { max: 1, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } }, setup: (p) => env.addMessage(t, tenant, { personId: p, at: new Date(env.NOON_SP.getTime() - 3600 * 1000 * 30) }) });
    produced.set('FREQUENCY_CAP', cap.row);
    const cooldown = await scenario(t, { flow: { cooldown: { amount: 10, unit: 'DAYS' }, frequencyCap: { max: 50, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } }, setup: async (p, f) => {
      const done = await env.makeRun(t, tenant, { versionId: f.versionId, personId: p, status: 'COMPLETED', actions: [env.sendAction({ at: new Date(env.NOON_SP.getTime() - 3600 * 1000).toISOString() })] });
      await env.addMessage(t, tenant, { personId: p, at: new Date(env.NOON_SP.getTime() - 3600 * 1000), actionKey: (await env.runRow(t, done)).actions_result[0].action_key });
    } });
    produced.set('COOLDOWN', cooldown.row);
    await env.publishRule(t, tenant, 'qa-m9-falsa', { fact: 'leadStage', op: '==', value: 'NUNCA' });
    produced.set('CONDITION_FALSE', (await scenario(t, { flow: { conditions: ['qa-m9-falsa'] } })).row);
    produced.set('CONDITION_ERROR', (await scenario(t, { flow: { conditions: ['qa-m9-regra-inexistente'] } })).row);
    produced.set('OUTSIDE_VALIDITY', (await scenario(t, { flow: { validUntil: '2026-02-01T00:00:00Z' } })).row);
    const campaign = await ks.mkCampaign(t, tenant, { status: 'DRAFT' });
    produced.set('CAMPAIGN_NOT_RUNNING', (await scenario(t, { flow: { triggerConfig: { campaignId: campaign.id } } })).row);
    const foreign = await env.asTenant(t, tenant, tenantB, () => env.readyPerson(t, tenantB));
    await env.publishedFlow(t, tenant, { eventType: 'crm.opportunity.won' });
    const cross = await env.run(t, tenant, env.eventFor(tenant, foreign, { eventType: 'crm.opportunity.won' }));
    produced.set('CROSS_COMPANY', await rows(t, cross.runs[0].runId));
    // motivos que nascem no executor das ações adiadas: a run espera o fim do silêncio e, até lá, o fluxo é pausado ou o contrato deixa de valer
    const waiting = await scenario(t, { runOptions: { now: env.NIGHT }, flow: { actions: [env.SEND(), env.TASK()] } });
    assert.equal(waiting.row.status, 'WAITING');
    await env.q(t, "UPDATE marketing.automation_flows SET status = 'PAUSED' WHERE id = :f", { f: waiting.published.flowId });
    await env.runner.runDueActions(tenant, t, { now: env.MORNING, mode: 'SANDBOX' });
    produced.set('AUTOMATION_PAUSED', await rows(t, waiting.row.id));
    const draftContract = await env.q(t, "INSERT INTO legal.contracts (id, group_id, company_id, contract_number, contract_type, status, total_value) VALUES (gen_random_uuid(), :g, :c, :n, 'SALE', 'DRAFT', 1000) RETURNING id", { g: tenant.groupId, c: tenant.companyId, n: `QA-M9-${env.uid().slice(0, 6)}` });
    const contract = await scenario(t, { runOptions: { now: env.NIGHT }, eventOver: { payload: { contractId: draftContract[0].id } }, flow: { triggerConfig: { requireActiveContract: true }, actions: [env.SEND(), env.TASK()] } });
    assert.equal(contract.row.status, 'WAITING');
    await env.runner.runDueActions(tenant, t, { now: env.MORNING, mode: 'SANDBOX' });
    produced.set('CONTRACT_NOT_ACTIVE', await rows(t, contract.row.id));
  });
  for (const reason of BLOCKED_REASONS) {
    const row = produced.get(reason);
    assert.ok(row, `faltou um caso para ${reason}`);
    assert.equal(row.status, 'BLOCKED', reason);
    assert.equal(row.blocked_reason, reason, reason);
  }
});

test('cap_avaliado_uma_unica_vez_dentro_do_cansend: uma consulta do cap por tentativa de envio, na ordem opt-out, quiet hours, cap, consent', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [env.SEND()] });
    let capQueries = 0;
    const original = sequelize.query.bind(sequelize);
    sequelize.query = (sql, ...rest) => { if (typeof sql === 'string' && /SELECT created_at AS at FROM crm\.messages/.test(sql)) capQueries += 1; return original(sql, ...rest); };
    try {
      const out = await env.run(t, tenant, env.eventFor(tenant, person));
      assert.equal((await rows(t, out.runs[0].runId)).status, 'COMPLETED');
    } finally { sequelize.query = original; }
    assert.equal(capQueries, 1, 'o cap é avaliado uma vez, só dentro do canSend');
    const step4 = (await rows(t, (await env.q(t, 'SELECT id FROM marketing.automation_runs WHERE subject_id = :p', { p: person }))[0].id)).policy_trace.find((e) => e.name === 'COOLDOWN');
    assert.deepEqual(step4.frequencyCap, { evaluatedBy: 'canSend', recalculated: false });
  });
});

test('runner_usa_politica_e_cansend_da_d416_e_d418: a acao de envio fica em actions_result na forma da DI-D416-3', async () => {
  await inTx(async (t) => {
    const r = await scenario(t, { flow: { actions: [env.SEND()] } });
    const send = r.row.actions_result[0];
    assert.equal(send.action_type, 'SEND_MESSAGE');
    assert.equal(send.status, 'OK');
    assert.equal(send.channel, 'WHATSAPP');
    assert.equal(send.purpose, 'MARKETING');
    assert.ok(!Number.isNaN(Date.parse(send.at)));
    assert.match(send.action_key, /^[0-9a-f]{64}$/);
    const conditions = r.row.policy_trace.find((e) => e.name === 'CONDITIONS');
    assert.equal(conditions.evaluatedBy, 'evaluateAutomationPolicy');
  });
});
