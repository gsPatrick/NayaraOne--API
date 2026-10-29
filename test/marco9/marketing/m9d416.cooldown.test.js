'use strict';

// M9-D416 — cooldown da automação por pessoa e canal (passo 4 do runner). Banco descartável; ver m9d416.cap.test.js para o comando.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { evaluateAutomationPolicy } = require('../../../src/features/marketing/automations/policy');
const env = require('../_helpers/mktPolicyEnv');

const { addMessage, readyPerson, makeFlowVersion, makeRun, sendAction, sha, uid } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
const at = (iso) => new Date(iso);
const policy = (t, flow, personId, now, channel = 'WHATSAPP') => evaluateAutomationPolicy(
  { version: { flowId: flow.flowId, conditions: [], cooldown: flow.cooldown }, subject: { type: 'PERSON', id: personId }, channel, now }, A, t);

test('cooldown_72h_bloqueia_e_libera', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const flow = await makeFlowVersion(t, A);
    // última mensagem em 05/11 às 10:00 de São Paulo (13:00Z)
    await makeRun(t, A, { versionId: flow.versionId, personId, actions: [sendAction({ at: '2026-11-05T13:00:00.000Z' })] });
    const blocked = await policy(t, flow, personId, at('2026-11-07T12:00:00Z')); // 07/11 09:00 em São Paulo
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'COOLDOWN');
    assert.equal(blocked.code, 'MKT_COOLDOWN_ACTIVE');
    assert.equal(blocked.message, 'A automação está em período de espera para esta pessoa.');
    assert.equal(blocked.nextEligibleAt.toISOString(), '2026-11-08T13:00:00.000Z');
    assert.equal((await policy(t, flow, personId, at('2026-11-08T12:59:59Z'))).reason, 'COOLDOWN');
    assert.equal((await policy(t, flow, personId, at('2026-11-08T13:00:00Z'))).allowed, true); // 08/11 10:00 liberada
  });
});

test('cooldown_conta_o_horario_da_acao_e_so_aceitas_pelo_provedor', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const flow = await makeFlowVersion(t, A, { cooldown: { amount: 3, unit: 'DAYS' } });
    const failedKey = sha(uid());
    // ação OK cuja mensagem FALHOU não conta; ação SKIPPED/PENDING não conta
    await makeRun(t, A, { versionId: flow.versionId, personId, actions: [sendAction({ action_key: failedKey, at: '2026-11-06T13:00:00.000Z' })] });
    await addMessage(t, A, { personId, actionKey: failedKey, status: 'FAILED', at: at('2026-11-06T13:00:01Z') });
    await makeRun(t, A, { versionId: flow.versionId, personId, actions: [sendAction({ status: 'SKIPPED', at: '2026-11-06T14:00:00.000Z' }), sendAction({ status: 'PENDING', at: '2026-11-06T14:00:00.000Z' })] });
    assert.equal((await policy(t, flow, personId, at('2026-11-07T13:00:00Z'))).allowed, true);
    // mensagem aceita (SENT, sem confirmação de entrega): conta pelo horário da AÇÃO (a run terminou depois)
    const okKey = sha(uid());
    await makeRun(t, A, { versionId: flow.versionId, personId, actions: [sendAction({ action_key: okKey, at: '2026-11-06T13:00:00.000Z' })] });
    await addMessage(t, A, { personId, actionKey: okKey, status: 'SENT', at: at('2026-11-09T01:00:00Z') });
    const blocked = await policy(t, flow, personId, at('2026-11-07T13:00:00Z'));
    assert.equal(blocked.reason, 'COOLDOWN');
    assert.equal(blocked.nextEligibleAt.toISOString(), '2026-11-09T13:00:00.000Z', '3 dias contados do horário da ação');
  });
});

test('cooldown_vale_por_automacao_pessoa_e_canal', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const flow = await makeFlowVersion(t, A);
    const otherFlow = await makeFlowVersion(t, A);
    await makeRun(t, A, { versionId: flow.versionId, personId, actions: [sendAction({ at: '2026-11-06T13:00:00.000Z' })] });
    const now = at('2026-11-07T13:00:00Z');
    assert.equal((await policy(t, flow, personId, now)).reason, 'COOLDOWN');
    assert.equal((await policy(t, flow, personId, now, 'EMAIL')).allowed, true, 'outro canal');
    assert.equal((await policy(t, otherFlow, personId, now)).allowed, true, 'outra automação');
    assert.equal((await policy(t, flow, await readyPerson(t, A), now)).allowed, true, 'outra pessoa');
    // run ainda em andamento (não COMPLETED) não gera cooldown
    const flow3 = await makeFlowVersion(t, A);
    await makeRun(t, A, { versionId: flow3.versionId, personId, status: 'STARTED', actions: [sendAction({ at: '2026-11-06T13:00:00.000Z' })] });
    assert.equal((await policy(t, flow3, personId, now)).allowed, true);
  });
});
