'use strict';

// M9-D429 regra 6 — status de entrega do WhatsApp e do e-mail: SENT só quando o canal aceita; DELIVERED/READ só pela confirmação do canal; FAILED, UNDELIVERED e
// BOUNCED gravam FAILED sem tocar o último contato nem as tarefas de contatar; SENT sem confirmação conta para o cap e NÃO conta como contato do CRM; o status
// é idempotente e vale o mais avançado; bounce permanente e reclamação viram supressão. Postgres real, transação com rollback. Só em banco descartável.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { loadOpportunityFacts } = require('../../../src/features/ai/agents/nay_comercial/comercial.data');
const env = require('../_helpers/mktMsgEnv');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

const { readyPerson, makeOpportunity, byKey, key, send, adapters, messaging } = env;
let A;
let offVault;
before(async () => { ({ a: A } = await env.tenants()); offVault = useTempSecretStore(); });
beforeEach(() => adapters.resetSandbox());
after(async () => { offVault(); await sequelize.close(); });

const mail = (personId, over = {}) => ({ channel: 'EMAIL', personId, purpose: 'MARKETING', actionKey: key(), subject: 'Novidades', text: 'Veja os imóveis.', unsubscribeUrl: 'https://www.exemplo.test/d?t=1', ...over });
const status = (t, providerRef, raw, channel = 'EMAIL') => messaging.applyDeliveryStatus({ tenant: A, channel, providerRef, status: raw }, t);
const snapshot = async (t, oppId) => ({
  opp: (await env.q(t, 'SELECT stage, next_action, next_action_due_at, updated_at FROM crm.opportunities WHERE id = :id', { id: oppId }))[0],
  tasks: (await env.q(t, "SELECT id, status, title FROM core.tasks WHERE company_id = :c AND related_entity_id = :id ORDER BY id", { c: A.companyId, id: oppId })),
});

async function sentMessage(t, over = {}) {
  const personId = await readyPerson(t, A);
  const opportunityId = await makeOpportunity(t, A, personId);
  const input = mail(personId, { opportunityId, ...over });
  const out = await send(t, A, input);
  assert.equal(out.status, 'SENT');
  return { personId, opportunityId, input, out, ref: out.providerRef };
}

test('status_entregue_so_apos_confirmacao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const m = await sentMessage(t);
    assert.equal((await byKey(t, A, m.input.actionKey)).delivery_status, 'SENT', 'o aceite do canal é só SENT, nunca entregue');
    assert.equal(m.out.sent, true);
    assert.equal((await status(t, m.ref, 'DELIVERED')).to, 'DELIVERED');
    assert.equal((await byKey(t, A, m.input.actionKey)).status, 'DELIVERED');
    assert.equal((await status(t, m.ref, 'OPENED')).to, 'READ', 'e-mail aberto = lido');
    // status sem confirmação possível: desconhecido ou de mensagem que não é nossa não muda nada
    assert.deepEqual(await status(t, m.ref, 'ALGO_NOVO'), { applied: false, reason: 'STATUS_UNMAPPED' });
    assert.deepEqual(await status(t, 'sbx-email-inexistente', 'DELIVERED'), { applied: false, reason: 'UNKNOWN_MESSAGE' });
    // a consulta direta ao canal (getStatus) confirma a entrega pela mesma regra
    const adapter = await adapters.resolveChannelAdapter('EMAIL', { tenant: A, transaction: t, mode: 'SANDBOX' });
    assert.equal((await adapter.getStatus(m.ref)).status, 'DELIVERED');
  });
});

test('falha_de_entrega_grava_status_failed_e_preserva_ultimo_contato', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const personId = await readyPerson(t, A);
    const opportunityId = await makeOpportunity(t, A, personId);
    await env.q(t, "INSERT INTO core.tasks (id, group_id, company_id, title, status, related_entity_type, related_entity_id) VALUES (gen_random_uuid(), :g, :c, 'Contatar o cliente', 'OPEN', 'Opportunity', :o) RETURNING id", { g: A.groupId, c: A.companyId, o: opportunityId }).catch(() => null);
    const before = await snapshot(t, opportunityId);
    const factsBefore = await loadOpportunityFacts(opportunityId, t, { now: new Date() });
    for (const raw of ['FAILED', 'UNDELIVERED', 'BOUNCED_SOFT']) {
      const input = mail(personId, { opportunityId });
      const out = await send(t, A, input);
      const r = await status(t, out.providerRef, raw);
      assert.deepEqual([r.applied, r.to], [true, 'FAILED'], raw);
      const row = await byKey(t, A, input.actionKey);
      assert.deepEqual([row.status, row.delivery_status], ['FAILED', 'FAILED']);
      assert.ok(row.failure_reason, 'o motivo em português fica gravado');
    }
    const factsAfter = await loadOpportunityFacts(opportunityId, t, { now: new Date() });
    assert.equal(factsAfter.lastInteractionAt, factsBefore.lastInteractionAt, 'o último contato não muda com mensagem que falhou');
    assert.deepEqual(factsAfter.interactions, []);
    assert.deepEqual(await snapshot(t, opportunityId), before, 'oportunidade e tarefas de contatar ficam como estavam');
    assert.deepEqual(factsAfter.openTasks, factsBefore.openTasks);
    // FAILED depois de READ não sobrescreve
    const read = await sentMessage(t);
    await status(t, read.ref, 'READ');
    assert.deepEqual([(await status(t, read.ref, 'FAILED')).applied, (await byKey(t, A, read.input.actionKey)).status], [false, 'READ']);
  });
});

test('email_sent_sem_confirmacao_conta_no_cap_e_nao_conta_como_contato', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const m = await sentMessage(t);
    // SENT: conta para cooldown e cap (M9-D416: aceita pelo provedor) ...
    const counted = await env.q(t, "SELECT count(*)::int AS n FROM crm.messages WHERE company_id = :c AND person_id = :p AND channel = 'EMAIL' AND purpose = 'MARKETING' AND status IN ('SENT','DELIVERED','READ','UNKNOWN')", { c: A.companyId, p: m.personId });
    assert.equal(counted[0].n, 1);
    // ... e NÃO é contato do CRM: o último contato só passa a existir com DELIVERED ou READ
    const sentFacts = await loadOpportunityFacts(m.opportunityId, t, { now: new Date() });
    assert.deepEqual([sentFacts.lastInteractionAt, sentFacts.contactBase, sentFacts.interactions.length], [null, 'CREATED', 0]);
    await status(t, m.ref, 'DELIVERED');
    const deliveredFacts = await loadOpportunityFacts(m.opportunityId, t, { now: new Date() });
    assert.deepEqual([deliveredFacts.contactBase, deliveredFacts.interactions.length], ['INTERACTION', 1]);
    assert.ok(deliveredFacts.lastInteractionAt);
    // mensagem de pessoa (sem action_key) continua contando quando aceita, como na M9-D229
    // M3-CAD-18: o autor da interação é imutável no banco; a mensagem já nasce da pessoa da equipe (só a ligação com a oportunidade vem depois).
    const humana = await env.addMessage(t, A, { personId: m.personId, channel: 'WHATSAPP', status: 'SENT', at: new Date(), authorType: 'EMPLOYEE' });
    await env.q(t, 'UPDATE crm.messages SET opportunity_id = :o WHERE id = :id RETURNING id', { o: m.opportunityId, id: humana });
    assert.equal((await loadOpportunityFacts(m.opportunityId, t, { now: new Date() })).interactions.length, 2);
  });
});

test('falha_de_entrega_nao_finge_contato', async () => {
  // Não tem corpo próprio (M9-D429 seção 8): a regra é da dona M9-D229, `messaging_delivery_somente_por_evidencia` e `messaging_falha_de_entrega_nao_cria_entregue_nem_contato`
  // (test/marco9/integracoes/m9d229.fluxo.test.js), que roda junto na bateria; aqui se confere só o lado do Marketing.
  await withRollbackTenantTransaction(A, async (t) => {
    const m = await sentMessage(t, { channel: 'EMAIL' });
    await status(t, m.ref, 'BOUNCED_SOFT');
    const facts = await loadOpportunityFacts(m.opportunityId, t, { now: new Date() });
    assert.equal(facts.interactions.length, 0, 'e-mail devolvido não é contato');
    assert.equal(facts.lastInteractionAt, null);
    const d229 = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'integracoes', 'm9d229.fluxo.test.js'), 'utf8');
    assert.match(d229, /messaging_delivery_somente_por_evidencia/);
  });
});

test('webhook_de_status_idempotente_e_vale_o_mais_avancado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const m = await sentMessage(t);
    const first = await status(t, m.ref, 'DELIVERED');
    const replay = await status(t, m.ref, 'DELIVERED');
    assert.deepEqual([first.applied, replay.applied, replay.reason], [true, false, 'NOT_NEWER']);
    // fora de ordem: READ chega antes do DELIVERED atrasado; o atrasado não regride
    const n = await sentMessage(t);
    await status(t, n.ref, 'READ');
    assert.equal((await status(t, n.ref, 'DELIVERED')).applied, false);
    assert.equal((await byKey(t, A, n.input.actionKey)).status, 'READ');
    // um evento por (providerRef, status): o histórico guarda uma só mudança de cada tipo
    const audits = await env.q(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.message.delivery_status' AND entity_id = :id", { c: A.companyId, id: (await byKey(t, A, m.input.actionKey)).id });
    assert.equal(audits[0].n, 1);
  });
});

test('bounce_permanente_reclamacao_e_numero_invalido_viram_supressao_e_bounce_leve_nao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const hard = await sentMessage(t);
    assert.equal((await status(t, hard.ref, 'BOUNCED_HARD')).suppressed, true);
    const rows = await env.suppressions(t, hard.personId);
    assert.deepEqual([rows.length, rows[0].reason, rows[0].channel, rows[0].source], [1, 'BOUNCE', 'EMAIL', 'PERMANENT_BOUNCE']);
    // a pessoa suprimida não recebe mais: o canSend barra o envio seguinte
    assert.equal((await send(t, A, mail(hard.personId))).reason, 'SUPPRESSED');
    const complaint = await sentMessage(t);
    await status(t, complaint.ref, 'COMPLAINED');
    assert.equal((await env.suppressions(t, complaint.personId))[0].reason, 'COMPLAINT');
    const soft = await sentMessage(t);
    assert.equal((await status(t, soft.ref, 'BOUNCED_SOFT')).suppressed, false);
    assert.equal((await env.suppressions(t, soft.personId)).length, 0, 'devolução temporária não suprime');
    // WhatsApp: número inválido vira supressão do canal
    const person = await readyPerson(t, A);
    await env.openWindow(t, A, person, 1);
    const w = await send(t, A, { channel: 'WHATSAPP', personId: person, purpose: 'MARKETING', actionKey: key(), text: 'Olá' });
    assert.equal((await status(t, w.providerRef, 'INVALID_NUMBER', 'WHATSAPP')).suppressed, true);
    assert.equal((await env.suppressions(t, person))[0].channel, 'WHATSAPP');
  });
});

test('estados_concorrentes_da_mesma_mensagem_terminam_no_mais_avancado', async () => {
  // a linha é travada (FOR UPDATE): duas aplicações seguidas em qualquer ordem terminam em READ
  for (const order of [['DELIVERED', 'READ', 'FAILED'], ['FAILED', 'READ', 'DELIVERED'], ['READ', 'FAILED', 'DELIVERED']]) {
    await withRollbackTenantTransaction(A, async (t) => {
      const m = await sentMessage(t);
      for (const raw of order) await status(t, m.ref, raw);
      const final = (await byKey(t, A, m.input.actionKey)).status;
      // FAILED antes de qualquer entrega é terminal; depois de DELIVERED/READ não vale
      assert.equal(final, order[0] === 'FAILED' ? 'FAILED' : 'READ', order.join('>'));
    });
  }
});
