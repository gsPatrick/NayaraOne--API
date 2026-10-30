'use strict';

// M9-D436 adv_06 (Caderno §16: "Frequency cap excedido -> bloqueia"). Cap de 3 mensagens em 7 dias com 3 já enviadas (01/11, 03/11, 05/11); a 4ª tentativa, por outra automação em 06/11, é
// BLOCKED FREQUENCY_CAP com nextEligibleAt em 08/11. Cenário da dona (M9-D416), sem lógica própria. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const env = require('../../_helpers/mktRunner');
const adv = require('../../_helpers/mktAdv');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { useTempSecretStore } = require('../../_helpers/mktSecretStore');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

test('adv_06_frequency_cap_excedido_bloqueia', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const personId = await env.readyPerson(t, A);
    for (const day of ['2026-11-01', '2026-11-03', '2026-11-05']) await env.addMessage(t, A, { personId, status: 'SENT', at: new Date(`${day}T15:00:00Z`) });
    const flow = await env.publishedFlow(t, A, { actions: [env.SEND({ channel: 'WHATSAPP', purpose: 'MARKETING' })], cooldown: { amount: 1, unit: 'HOURS' } });
    const before = adv.sandboxCount(A, 'WHATSAPP');

    const out = await env.run(t, A, env.eventFor(A, personId), { now: new Date('2026-11-06T15:00:00Z') });
    const row = await env.runRow(t, out.runs[0].runId);
    // (1) a 4ª mensagem não saiu: nada no adapter e nenhuma mensagem nova no CRM
    assert.equal(adv.sandboxCount(A, 'WHATSAPP'), before);
    assert.equal((await env.messagesOf(t, personId)).filter((m) => !/^qa-/.test(String(m.action_key || ''))).length, 3, 'continuam as 3 mensagens de antes');
    // (2) o motivo foi registrado: BLOCKED FREQUENCY_CAP, contagem 3 de 3 e a próxima data elegível
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'FREQUENCY_CAP');
    const send = env.sendEntry(row);
    assert.equal(send.status, 'SKIPPED');
    assert.match(JSON.stringify(send), /FREQUENCY_CAP/);
    const sup = row.policy_trace.find((p) => p.name === 'SUPPRESSION_CONSENT').sends[0];
    assert.equal(sup.reason, 'FREQUENCY_CAP');
    assert.equal(sup.nextEligibleAt, '2026-11-08T15:00:00.000Z', 'nextEligibleAt = 08/11, quando a mensagem de 01/11 sai da janela de 7 dias');
    assert.ok(flow.flowId);
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await adv.assertIsolated(t, A, [{ tabela: 'marketing.automation_runs', ids: [row.id] }]);
  });
});
