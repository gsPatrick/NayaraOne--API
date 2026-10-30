'use strict';

// M9-D440 guard_replay_is_safe (Guia §14: "Não duplicar post/mensagem em replay"). Estática: as âncoras de idempotência de cada fluxo existem no código. Dinâmica: cada fluxo é reexecutado 3 vezes e a
// contagem de mensagens e posts fica em 1 (runner, mensagem direta, agendamento e worker, step de campanha por destinatário e pedido de avaliação).
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const leads = require('../../_helpers/mktLeads');
const worker = require('../../_helpers/mktWorker');
const adv = require('../../_helpers/mktAdv');
const rv = require('../../_helpers/mktReviews');
const msg = require('../../_helpers/mktMsgEnv');
const g = require('../../_helpers/mktGuardas');
const lifecycle = require('../../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../../src/features/marketing/campaigns/sendPort');
const { upsertSetting } = require('../../../../src/features/settings/settings.service');

const NOME = 'guard_replay_is_safe';
const TICK = new Date('2031-12-01T12:00:10Z');
const VEZES = [1, 2, 3];
let A;
let ctx;
let offVault;
let espiao;
before(async () => { ({ tenantA: A } = await leads.prepararTenants()); offVault = leads.useTempSecretStore(); ctx = await worker.setup(); });
beforeEach(() => { adv.adapters.resetSandbox(); espiao = g.espiarCanais(); registerCampaignSendPort(adv.messaging.buildMessagingCampaignPort()); });
afterEach(() => { espiao.restaurar(); clearCampaignSendPort(); worker.reset(); worker.resetSandbox(); });
after(async () => { offVault(); await sequelize.close(); });

test('guard_replay_is_safe: as âncoras de idempotência de cada fluxo existem no código', () => {
  g.assertSemViolacao(NOME);
});

test('guard_replay_is_safe: agendamento sem reaproveitar a chave do job é achado com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/publications/schedule/schedule.jobs.js', de: 'AND idempotency_key = :key AND deleted_at IS NULL`', para: 'AND idempotency_key <> :key AND deleted_at IS NULL`' }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.deepEqual(achados.map((a) => a.arquivo), ['publications/schedule/schedule.jobs.js']);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_replay_is_safe: o mesmo evento do lead 3 vezes = 1 run, 1 mensagem e 1 tarefa', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    await leads.install(t, A, 'LEAD-NOVO');
    const lead = await leads.lead(t, A, {});
    const event = leads.leadEvent(A, lead);
    for (const n of VEZES) {
      await leads.run(t, A, event);
      assert.equal((await leads.outbound(t, lead.personId)).length, 1, `mensagens depois da execução ${n}`);
    }
    assert.equal((await adv.q(t, 'SELECT id FROM marketing.automation_runs WHERE subject_id = :p OR subject_id = :o', { p: lead.personId, o: lead.opportunityId })).length, 1);
    assert.equal((await leads.tasksOf(t, A, lead.personId)).filter((r) => r.title === 'Contatar lead novo').length, 1);
    assert.equal(espiao.envios('EMAIL').length, 1, 'o adapter recebeu uma chamada');
  });
});

test('guard_replay_is_safe: a mesma ação de mensagem 3 vezes = 1 mensagem no CRM e 1 chamada ao adapter', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    const person = await msg.readyPerson(t, A);
    await msg.openWindow(t, A, person);
    const input = { channel: 'WHATSAPP', personId: person, purpose: 'MARKETING', actionKey: msg.key(), text: 'Olá! Novidades para você.' };
    for (const n of VEZES) {
      assert.equal((await msg.send(t, A, input)).status, 'SENT', `execução ${n}`);
      assert.equal((await adv.q(t, "SELECT id FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND'", { p: person })).length, 1);
    }
    assert.equal(espiao.envios('WHATSAPP').length, 1);
  });
});

test('guard_replay_is_safe: agendar o mesmo post e rodar o worker 3 vezes = 1 job e 1 post', async () => {
  await worker.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await worker.scheduled(t, ctx, ['SITE']);
    for (const n of VEZES) {
      const again = await worker.schedule(t, ctx, s.itemId, { channels: ['SITE'], when: s.when.toISOString() });
      assert.equal(again.jobs[0].id, s.jobId, `agendamento ${n}`);
      await worker.cycle(t, ctx, { now: new Date(s.now.getTime() + n * 60000) });
    }
    assert.equal((await adv.q(t, 'SELECT id FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = :i)', { i: s.itemId })).length, 1);
    assert.equal(adv.adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 1, 'um único post');
    assert.equal(espiao.envios('SITE').length, 1);
  });
});

test('guard_replay_is_safe: o step da campanha reexecutado 3 vezes envia 1 vez por destinatário', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const people = [await leads.readyPerson(t, A), await leads.readyPerson(t, A)];
    const campaign = await adv.scheduledCampaign(t, A, people);
    for (const n of VEZES) {
      await lifecycle.runLifecycleTick(A, t, new Date(TICK.getTime() + n * 1000));
      assert.equal((await adv.deliveries(t, campaign.id)).length, 2, `entregas depois da execução ${n}`);
      assert.equal(espiao.envios('EMAIL').length, 2, `chamadas ao adapter depois da execução ${n}`);
    }
  });
});

test('guard_replay_is_safe: a mesma satisfação positiva 3 vezes = 1 pedido de avaliação e 1 mensagem', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    const person = await rv.ready(t, A);
    const sat = await rv.satisfaction(t, A, person, 5);
    for (const n of VEZES) {
      await rv.run(t, A, sat.input, { mode: 'SANDBOX' });
      assert.equal((await rv.requestOf(t, person)).length, 1, `pedidos depois da execução ${n}`);
      assert.equal((await rv.messagesOf(t, person)).length, 1);
    }
    assert.equal(espiao.envios('EMAIL').length, 1);
  });
});
