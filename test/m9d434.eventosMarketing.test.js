'use strict';

// M9-D434 — os 12 nomes (8 linhas) do catálogo de eventos de Marketing no outbox, com envelope, payload sem dado proibido,
// mesma transação e consumidor idempotente. Postgres real (RLS FORCE) com rollback; rodar em banco descartável.

const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { QueryTypes } = require('sequelize');
const { sequelize, getSeedTenant, withTenantTransaction } = require('./testHelpers');
const { withRollbackTenantTransaction } = require('./testHelpers');
const events = require('../src/modules/marketing/marketing.events');

let A;
const uid = () => crypto.randomUUID();
const ISO = '2031-12-01T12:00:00.000Z';
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });

before(async () => { A = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const SAMPLES = () => ({
  'marketing.content.created': { contentId: uid(), type: 'PROPERTY_POST', sourceEntity: { type: 'property', id: uid() }, versionNo: 1, createdBy: uid() },
  'marketing.content.approved': { contentId: uid(), versionNo: 2, approvedBy: uid(), autopublished: false },
  'marketing.publication.completed': { jobId: uid(), contentId: uid(), channel: 'INSTAGRAM', externalPostId: '17841400000000000', externalUrl: 'https://example.test/p/abc' },
  'marketing.publication.failed': { jobId: uid(), channel: 'INSTAGRAM', errorCode: 'MKT_PROVIDER_TIMEOUT' },
  'marketing.campaign.started': { campaignId: uid(), startsAt: ISO },
  'marketing.campaign.ended': { campaignId: uid(), endedAt: ISO, result: 12.5, cost: '9180.00' },
  'automation.run.started': { runId: uid(), flowId: uid(), versionNo: 3, subject: { type: 'person', id: uid() } },
  'automation.run.completed': { runId: uid(), actionsSummary: { ok: 3, skipped: 1 } },
  'automation.run.blocked': { runId: uid(), blockedReason: 'QUIET_HOURS' },
  'customer.opted_out': { personId: uid(), channel: 'WHATSAPP', purpose: 'MARKETING', source: 'LINK' },
  'review.requested': { reviewRequestId: uid(), personId: uid(), channel: 'EMAIL' },
  'attribution.recorded': { eventId: uid(), campaignId: uid(), personId: uid(), eventType: 'VISIT_SCHEDULED', touchRole: 'LAST' },
});
const LIVRO = Object.keys(SAMPLES());

const publish = (t, type, payload, extra = {}) => events.publishMarketingEvent({ type, payload, tenant: A, ...extra }, t);
const rows = (t, aggregateId) => q(t, 'SELECT * FROM integration.outbox_events WHERE aggregate_id = :aggregateId ORDER BY occurred_at', { aggregateId });

test('cada_um_dos_8_eventos_e_emitido_com_envelope', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const samples = SAMPLES();
    const correlationId = uid();
    for (const [type, payload] of Object.entries(samples)) {
      const row = await publish(t, type, payload, { correlationId });
      const [db] = await rows(t, row.aggregateId);
      assert.equal(db.event_type, type);
      assert.equal(db.event_version, 1);
      assert.equal(db.correlation_id, correlationId);
      const env = db.payload_json;
      assert.deepEqual(Object.keys(env).sort(), ['companyId', 'correlationId', 'eventId', 'groupId', 'occurredAt', 'payload', 'schemaVersion', 'type']);
      assert.match(env.eventId, /^[0-9a-f-]{36}$/);
      assert.equal(env.type, type);
      assert.equal(env.schemaVersion, 1);
      assert.equal(env.companyId, A.companyId);
      assert.equal(env.groupId, A.groupId);
      assert.equal(env.correlationId, correlationId);
      assert.equal(new Date(env.occurredAt).toISOString(), env.occurredAt);
      assert.deepEqual(env.payload, payload);
    }
  });
});

test('correlationId_ausente_e_gerado_e_gravado_na_coluna', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const row = await publish(t, 'marketing.campaign.started', SAMPLES()['marketing.campaign.started']);
    const [db] = await rows(t, row.aggregateId);
    assert.match(db.correlation_id, /^[0-9a-f-]{36}$/);
    assert.equal(db.payload_json.correlationId, db.correlation_id);
  });
});

test('evento_nao_contem_endereco_nem_texto_de_mensagem', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const base = SAMPLES()['customer.opted_out'];
    const ruins = [
      { ...base, email: 'fulano@example.test' },
      { ...base, address: 'Rua das Flores, 10' },
      { ...base, phone: '+5511999998888' },
      { ...base, body: 'Olá, tudo bem?' },
      { ...base, token: 'abc' },
      { ...base, channel: 'fulano@example.test' },
      { ...base, source: '+5511999998888' },
      { ...base, source: '(11) 99999-8888' },
      { ...base, source: 'x'.repeat(600) },
      { ...base, source: 'Bearer abcdefghijklmnop' },
    ];
    for (const payload of ruins) {
      await assert.rejects(() => publish(t, 'customer.opted_out', payload), (e) => e.code === 'MKT_EVENT_PAYLOAD_FORBIDDEN', JSON.stringify(payload).slice(0, 80));
    }
    const summary = SAMPLES()['automation.run.completed'];
    await assert.rejects(() => publish(t, 'automation.run.completed', { ...summary, actionsSummary: { message_text: 'oi', ok: 1 } }),
      (e) => e.code === 'MKT_EVENT_PAYLOAD_FORBIDDEN');
    await publish(t, 'automation.run.completed', { ...summary, actionsSummary: { accepted: 2, contexts: 1 } });
    for (const k of ['messageText', 'userEmail', 'cep', 'api_key']) assert.equal(events.forbiddenKey(k), true, k);
    const [{ n }] = await q(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = :id", { id: base.personId });
    assert.equal(n, 0);
  });
});

test('payload_com_formato_invalido_ou_campo_faltando_e_recusado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const ok = SAMPLES()['marketing.content.approved'];
    const { approvedBy, ...semCampo } = ok;
    await assert.rejects(() => publish(t, 'marketing.content.approved', semCampo), (e) => e.code === 'MKT_EVENT_PAYLOAD_INVALID');
    await assert.rejects(() => publish(t, 'marketing.content.approved', { ...ok, contentId: 'nao-e-uuid' }), (e) => e.code === 'MKT_EVENT_PAYLOAD_INVALID');
    await assert.rejects(() => publish(t, 'marketing.content.approved', { ...ok, autopublished: 'false' }), (e) => e.code === 'MKT_EVENT_PAYLOAD_INVALID');
    const at = SAMPLES()['attribution.recorded'];
    const { personId, ...semPessoa } = at;
    await assert.rejects(() => publish(t, 'attribution.recorded', semPessoa), (e) => e.code === 'MKT_EVENT_PAYLOAD_INVALID');
    await assert.rejects(() => publish(t, 'attribution.recorded', { ...at, personHash: 'a'.repeat(64) }), (e) => e.code === 'MKT_EVENT_PAYLOAD_INVALID');
    await publish(t, 'attribution.recorded', { ...semPessoa, personHash: 'a'.repeat(64) });
  });
});

test('sem_transacao_ou_sem_tenant_o_publicador_recusa', async () => {
  const payload = SAMPLES()['marketing.campaign.started'];
  await assert.rejects(() => events.publishMarketingEvent({ type: 'marketing.campaign.started', payload, tenant: A }), (e) => e.code === 'INTEGRATION_OUTBOX_TRANSACTION_REQUIRED');
  await withRollbackTenantTransaction(A, async (t) => {
    await assert.rejects(() => events.publishMarketingEvent({ type: 'marketing.campaign.started', payload, tenant: {} }, t), (e) => e.code === 'OUTBOX_TENANT_MISSING');
  });
});

test('rollback_nao_deixa_evento', async () => {
  const payload = SAMPLES()['marketing.campaign.started'];
  await assert.rejects(() => withTenantTransaction(A, async (t) => {
    await publish(t, 'marketing.campaign.started', payload);
    throw new Error('falha depois do evento');
  }), /falha depois do evento/);
  await withRollbackTenantTransaction(A, async (t) => {
    assert.deepEqual(await rows(t, payload.campaignId), []);
  });
});

test('mesma_chave_de_idempotencia_nao_duplica_o_evento', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const payload = SAMPLES()['marketing.content.approved'];
    const a = await publish(t, 'marketing.content.approved', payload);
    const b = await publish(t, 'marketing.content.approved', payload);
    assert.equal(a.id, b.id);
    assert.equal((await rows(t, payload.contentId)).length, 1);
    const c = await publish(t, 'marketing.content.approved', { ...payload, versionNo: 3 });
    assert.notEqual(a.id, c.id);
  });
});

test('consumidor_idempotente', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const row = await publish(t, 'review.requested', SAMPLES()['review.requested']);
    const seen = [];
    const handler = async (env) => { seen.push(env.eventId); };
    const first = await events.consumeMarketingEvent(row, 'bi.teste', handler, t);
    const second = await events.consumeMarketingEvent(row, 'bi.teste', handler, t);
    assert.deepEqual([first.processed, first.duplicate], [true, false]);
    assert.deepEqual([second.processed, second.duplicate], [false, true]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], row.payloadJson.eventId);
    const other = await events.consumeMarketingEvent(row, 'crm.teste', handler, t);
    assert.equal(other.processed, true, 'outro consumidor recebe o mesmo evento');
    assert.equal(seen.length, 2);
  });
});

test('catalogo_tem_exatamente_os_12_nomes_do_livro_e_nenhum_outro', async () => {
  assert.deepEqual([...events.EVENT_NAMES].sort(), [...LIVRO].sort());
  assert.equal(LIVRO.length, 12);
  assert.equal(events.EVENT_NAMES.includes('automation.run.failed'), false);
  await withRollbackTenantTransaction(A, async (t) => {
    for (const nome of ['automation.run.failed', 'marketing.content.deleted', 'marketing.publication', '']) {
      await assert.rejects(() => publish(t, nome, { runId: uid() }), (e) => e.code === 'MKT_EVENT_UNKNOWN', nome);
    }
    const [{ n }] = await q(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'automation.run.failed'");
    assert.equal(n, 0);
  });
});

test('automation_run_started_esta_no_catalogo_com_payload_e_produtor_D414', () => {
  const entry = events.EVENT_CATALOG['automation.run.started'];
  assert.ok(entry);
  assert.deepEqual([...entry.required].sort(), ['flowId', 'runId', 'subject', 'versionNo']);
  assert.equal(entry.producer, 'M9-D414');
  const produtores = Object.fromEntries(Object.entries(events.EVENT_CATALOG).map(([k, v]) => [k, v.producer]));
  assert.equal(produtores['marketing.content.created'], 'M9-D406');
  assert.equal(produtores['marketing.content.approved'], 'M9-D408');
  assert.equal(produtores['marketing.publication.failed'], 'M9-D411');
  assert.equal(produtores['marketing.campaign.ended'], 'M9-D412');
  assert.equal(produtores['automation.run.blocked'], 'M9-D414');
  assert.equal(produtores['customer.opted_out'], 'M9-D419');
  assert.equal(produtores['review.requested'], 'M9-D424');
  assert.equal(produtores['attribution.recorded'], 'M9-D431');
});

test('isolamento_entre_empresas_o_evento_nao_aparece_para_outro_tenant', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const payload = SAMPLES()['marketing.campaign.started'];
    await publish(t, 'marketing.campaign.started', payload);
    await sequelize.query("SELECT set_config('app.company_id', :c, true)", { transaction: t, replacements: { c: uid() } });
    assert.deepEqual(await rows(t, payload.campaignId), []);
  });
});
