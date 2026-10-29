'use strict';

// M9-D416 — frequency cap por pessoa, canal e finalidade (MKT-014), avaliado dentro do canSend. Postgres real, role de runtime (RLS FORCE),
// transação com rollback. Rodar SOMENTE em banco descartável (o .env aponta para a homologação remota), ver COMO_RETOMAR.md:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d416.cap.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { canSend } = require('../../../src/features/marketing/suppression/canSend');
const env = require('../_helpers/mktPolicyEnv');

const { addMessage, readyPerson, makeFlowVersion, makeRun, sendAction, sha, uid, DAY, NOON_SP } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
const at = (iso) => new Date(iso);
const send = (t, personId, instant, over = {}, purpose = 'MARKETING') => canSend(personId, over.channel || 'WHATSAPP', purpose, instant, { tenant: A, transaction: t, officialTemplate: true, ...over });
/** Três mensagens aceitas: 01/11, 03/11 e 05/11 de 2026, ao meio-dia em São Paulo. */
const seedThree = async (t, personId, status = 'SENT') => {
  for (const day of ['2026-11-01', '2026-11-03', '2026-11-05']) await addMessage(t, A, { personId, status, at: at(`${day}T15:00:00Z`) });
};

test('frequency_cap_excedido_bloqueia', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    await seedThree(t, personId);
    const decision = await send(t, personId, at('2026-11-06T15:00:00Z'));
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'FREQUENCY_CAP');
    assert.equal(decision.code, 'MKT_FREQUENCY_CAP_EXCEEDED');
    assert.equal(decision.message, 'Limite de mensagens atingido para esta pessoa.');
    assert.equal(decision.blocked_reason, 'FREQUENCY_CAP');
    assert.equal(decision.count, 3);
    assert.equal(decision.limit, 3);
  });
});

test('next_eligible_at_correto', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    await seedThree(t, personId);
    const blocked = await send(t, personId, at('2026-11-06T15:00:00Z'));
    // a de 01/11 sai da janela de 7 dias em 08/11 (mesmo horário)
    assert.equal(blocked.nextEligibleAt.toISOString(), '2026-11-08T15:00:00.000Z');
    const stillBlocked = await send(t, personId, at('2026-11-08T14:59:59Z'));
    assert.equal(stillBlocked.reason, 'FREQUENCY_CAP');
    const released = await send(t, personId, at(blocked.nextEligibleAt.toISOString()));
    assert.equal(released.allowed, true, JSON.stringify(released));
  });
});

test('cap_global_menor_prevalece', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    for (const day of ['2026-11-04', '2026-11-05']) await addMessage(t, A, { personId, at: at(`${day}T15:00:00Z`) });
    const instant = at('2026-11-06T15:00:00Z');
    // padrão 3: duas mensagens ainda cabem; cap da versão 5 não afrouxa o global
    assert.equal((await send(t, personId, instant, { capDaVersao: { max: 5, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } })).allowed, true);
    // cap global 2 (administrador) com a versão em 5: vale 2
    await upsertSetting('marketing.frequency_cap.global', '2 mensagens por 7 dias por pessoa, canal e finalidade', A, A.userId, t);
    const global = await send(t, personId, instant, { capDaVersao: { max: 5, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } });
    assert.equal(global.reason, 'FREQUENCY_CAP');
    assert.equal(global.limit, 2);
    // global 3 e versão 1 (mais restrita): vale 1
    await upsertSetting('marketing.frequency_cap.global', '3 mensagens por 7 dias por pessoa, canal e finalidade', A, A.userId, t);
    const version = await send(t, personId, instant, { capDaVersao: { max: 1, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } });
    assert.equal(version.reason, 'FREQUENCY_CAP');
    assert.equal(version.limit, 1);
  });
});

test('janela_movel_em_america_sao_paulo', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    // 3 mensagens: duas dentro e uma exatamente 7 x 24 h antes de "agora" (fora da janela móvel), uma delas às 23:30 de São Paulo
    const now = at('2026-11-10T15:00:00Z'); // 12:00 em São Paulo
    await addMessage(t, A, { personId, at: new Date(now.getTime() - 7 * DAY) });
    await addMessage(t, A, { personId, at: at('2026-11-04T02:30:00Z') }); // 03/11 23:30 em São Paulo
    await addMessage(t, A, { personId, at: at('2026-11-09T13:00:00Z') });
    assert.equal((await send(t, personId, now)).allowed, true, 'a mensagem de exatamente 7 x 24 h já saiu da janela');
    // um segundo antes, a mesma mensagem ainda conta: 3 de 3
    const earlier = at('2026-11-10T14:59:59Z');
    const blocked = await send(t, personId, earlier);
    assert.equal(blocked.reason, 'FREQUENCY_CAP');
    // horário de silêncio e liberação são lidos no fuso de São Paulo: 00:30 UTC = 21:30 (silêncio); 11:00 UTC = 08:00 (liberado)
    assert.equal((await send(t, await readyPerson(t, A), at('2026-11-11T00:30:00Z'))).reason, 'QUIET_HOURS');
    assert.equal((await send(t, await readyPerson(t, A), at('2026-11-11T11:00:00Z'))).allowed, true);
  });
});

test('cap_e_cooldown_contam_sent_e_ignoram_failed', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const base = at('2026-11-05T15:00:00Z');
    for (const status of ['FAILED', 'UNDELIVERED', 'BOUNCED']) await addMessage(t, A, { personId, status, at: base });
    const instant = at('2026-11-06T15:00:00Z');
    assert.equal((await send(t, personId, instant)).allowed, true, 'mensagens que falharam não contam');
    await addMessage(t, A, { personId, status: 'SENT', at: base }); // e-mail aceito sem confirmação de entrega conta
    await addMessage(t, A, { personId, status: 'UNKNOWN', at: base });
    assert.equal((await send(t, personId, instant)).allowed, true, '2 de 3');
    await addMessage(t, A, { personId, status: 'READ', at: base });
    const blocked = await send(t, personId, instant);
    assert.equal(blocked.reason, 'FREQUENCY_CAP');
    assert.equal(blocked.count, 3);
    // a contagem é por pessoa, canal e finalidade: outro canal, outra finalidade e mensagem recebida não consomem este cap
    const other = await readyPerson(t, A);
    await addMessage(t, A, { personId: other, channel: 'EMAIL', at: base });
    await addMessage(t, A, { personId: other, channel: 'EMAIL', at: base });
    await addMessage(t, A, { personId: other, channel: 'EMAIL', at: base });
    await addMessage(t, A, { personId: other, purpose: 'NUTRICAO', at: base });
    await addMessage(t, A, { personId: other, direction: 'INBOUND', status: 'RECEIVED', at: base });
    assert.equal((await send(t, other, instant, { channel: 'WHATSAPP' })).allowed, true);
    assert.equal((await send(t, other, instant, { channel: 'EMAIL' })).reason, 'FREQUENCY_CAP');
  });
});

test('cap_conta_acoes_reservadas_em_runs_nao_terminais', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const { versionId } = await makeFlowVersion(t, A);
    const instant = at('2026-11-06T15:00:00Z');
    const mine = () => sendAction({ status: 'PENDING', at: '2026-11-05T15:00:00.000Z' });
    await makeRun(t, A, { versionId, personId, status: 'STARTED', actions: [mine(), mine()] });
    await makeRun(t, A, { versionId, personId, status: 'COMPLETED', actions: [mine()] }); // terminal: já virou mensagem (ou falhou), não é reserva
    assert.equal((await send(t, personId, instant)).allowed, true, 'duas reservas de 3');
    await makeRun(t, A, { versionId, personId, status: 'WAITING', actions: [mine()] });
    assert.equal((await send(t, personId, instant)).reason, 'FREQUENCY_CAP');
    // reserva que já virou mensagem (mesma action_key) não conta duas vezes
    const dup = await readyPerson(t, A);
    const key = sha(uid());
    await makeRun(t, A, { versionId, personId: dup, status: 'STARTED', actions: [sendAction({ action_key: key, status: 'OK', at: '2026-11-05T15:00:00.000Z' })] });
    await addMessage(t, A, { personId: dup, actionKey: key, at: at('2026-11-05T15:00:00Z') });
    await addMessage(t, A, { personId: dup, at: at('2026-11-05T16:00:00Z') });
    assert.equal((await send(t, dup, instant)).allowed, true, '2 contados (a reserva e a mensagem têm a mesma chave)');
  });
});

test('cap_avalia_uma_vez_e_reserva_na_mesma_trava', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const { versionId } = await makeFlowVersion(t, A);
    const runId = await makeRun(t, A, { versionId, personId, status: 'STARTED' });
    const cap = { max: 1, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' };
    const instant = at('2026-11-06T15:00:00Z');
    const first = await send(t, personId, instant, { capDaVersao: cap, reserve: { runId, actionKey: sha(uid()) } });
    assert.equal(first.allowed, true);
    const second = await send(t, personId, instant, { capDaVersao: cap });
    assert.equal(second.reason, 'FREQUENCY_CAP', 'a reserva da primeira tentativa já conta');
    void NOON_SP;
  });
});
