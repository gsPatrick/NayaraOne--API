'use strict';

// M9-D440 guard_kill_switch_always_checked (Guia §14: "Não permitir automação sem kill switch"). Estática: runner, retomada do runner, worker, disparador de campanha, porta de saída de canal, envio de
// mensagem e agendamento consultam o kill switch. Dinâmica: com o kill switch global ligado, runner, worker e campanha não chamam o adapter (espião: zero) e, desligado, o job pendente é processado.
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const leads = require('../../_helpers/mktLeads');
const worker = require('../../_helpers/mktWorker');
const adv = require('../../_helpers/mktAdv');
const g = require('../../_helpers/mktGuardas');
const lifecycle = require('../../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../../src/features/marketing/campaigns/sendPort');
const { upsertSetting } = require('../../../../src/features/settings/settings.service');

const NOME = 'guard_kill_switch_always_checked';
const TICK = new Date('2031-12-01T12:00:10Z');
let A;
let ctx;
let offVault;
let espiao;
before(async () => { ({ tenantA: A } = await leads.prepararTenants()); offVault = leads.useTempSecretStore(); ctx = await worker.setup(); });
beforeEach(() => { adv.adapters.resetSandbox(); espiao = g.espiarCanais(); registerCampaignSendPort(adv.messaging.buildMessagingCampaignPort()); });
afterEach(() => { espiao.restaurar(); clearCampaignSendPort(); worker.reset(); worker.resetSandbox(); });
after(async () => { offVault(); await sequelize.close(); });

test('guard_kill_switch_always_checked: runner, worker, campanha e porta de saída consultam o kill switch', () => {
  g.assertSemViolacao(NOME);
});

test('guard_kill_switch_always_checked: o runner sem a consulta ao kill switch é achado, e a cópia sem a chamada reprova (arquivo e linha)', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/campaigns/stepDispatcher.js', de: 'if ((await isOutboundBlocked(', para: 'if ((await Promise.resolve({ blocked: false }) || (' }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.deepEqual(achados.map((a) => a.arquivo), ['campaigns/stepDispatcher.js']);
    assert.match(g.formatar(achados[0]), /disparador de campanha deve consultar o kill switch/);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_kill_switch_always_checked: com o kill switch global ligado, runner, worker e campanha não chamam o adapter; desligado, o job pendente sai', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    await leads.install(t, A, 'LEAD-NOVO');
    const lead = await leads.lead(t, A, {});
    const campaign = await adv.scheduledCampaign(t, A, [await leads.readyPerson(t, A), await leads.readyPerson(t, A)]);
    const post = await worker.scheduled(t, ctx, ['SITE']);
    await adv.on(t, A, 'GLOBAL');

    const out = await leads.run(t, A, leads.leadEvent(A, lead));
    assert.deepEqual([(await leads.runRow(t, out.runs[0].runId)).blocked_reason], ['KILL_SWITCH'], 'runner');
    await worker.cycle(t, ctx, { now: post.now });
    assert.equal((await worker.job(t, post.jobId)).status, 'PENDING', 'worker');
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await adv.deliveries(t, campaign.id)).length, 0, 'campanha');
    assert.equal(espiao.envios().length, 0, 'espião: o adapter não foi chamado por nenhuma das três portas');

    await adv.off(t, A, 'GLOBAL');
    await worker.cycle(t, ctx, { now: new Date(post.now.getTime() + 60000) });
    assert.equal((await worker.job(t, post.jobId)).status, 'PUBLISHED');
    assert.equal(espiao.envios('SITE').length, 1);
  });
});
