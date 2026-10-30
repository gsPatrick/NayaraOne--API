'use strict';

// M9-D424 — corrida real (duas conexões, COMMIT): dois processamentos da mesma satisfação geram um pedido e uma mensagem. Só em banco descartável com DATABASE_ADMIN_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');
const reviews = require('../../../src/features/marketing/automations/reviews');
const rv = require('../_helpers/mktReviews');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';
let tenant;
let offVault;
before(async () => { ({ tenantA: tenant } = await rv.prepararTenants()); offVault = rv.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
const tx = (fn) => withTenantTransaction(tenant, fn);

const SETTINGS = ['marketing.review.url_avaliacao', 'marketing.review.url_base_rastreio', 'marketing.email.url_descadastro'];

async function cleanup(personId, outboxId) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    const links = (await admin.query('SELECT tracking_link_id FROM marketing.review_requests WHERE person_id = $1 AND tracking_link_id IS NOT NULL', [personId])).rows.map((r) => r.tracking_link_id);
    await admin.query('UPDATE marketing.review_requests SET message_id = NULL, tracking_link_id = NULL WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM integration.outbox_events WHERE aggregate_id IN (SELECT id FROM marketing.review_requests WHERE person_id = $1) OR id = $2', [personId, outboxId]);
    await admin.query('DELETE FROM marketing.review_requests WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM marketing.tracking_links WHERE id = ANY($1::uuid[])', [links]);
    await admin.query('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2)', [tenant.companyId, SETTINGS]);
    await admin.query('DELETE FROM crm.messages WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.communication_consents WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.person_contacts WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.persons WHERE id = $1', [personId]);
  } finally { await admin.end(); }
}

test('dois_processamentos_da_mesma_satisfacao_geram_um_pedido_e_uma_mensagem', { skip: SKIP }, async () => {
  const { personId, outboxId } = await tx(async (t) => {
    await rv.configure(t, tenant);
    const person = await rv.readyPerson(t, tenant, { phone: null, optIn: ['AVALIACAO'] });
    const sat = await rv.satisfaction(t, tenant, person, 5);
    return { personId: person, outboxId: sat.outboxId };
  });
  try {
    const call = (key) => tx((t) => reviews.requestReview({ tenant, transaction: t, personId, platform: 'GOOGLE', channel: 'AUTO', idempotencyKey: key, correlationId: rv.uid(), mode: 'SANDBOX', now: rv.NOON_SP, context: { eventId: outboxId } }));
    const results = await Promise.allSettled([call(rv.sha('corrida-1')), call(rv.sha('corrida-1')), call(rv.sha('corrida-2'))]);
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.message)));
    assert.equal(new Set(results.map((r) => r.value.reviewRequestId)).size, 1, 'todas devolvem o mesmo pedido');
    const [{ requests }, { messages }] = await tx(async (t) => [
      (await rv.q(t, 'SELECT count(*)::int AS requests FROM marketing.review_requests WHERE person_id = :p', { p: personId }))[0],
      (await rv.q(t, "SELECT count(*)::int AS messages FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND'", { p: personId }))[0],
    ]);
    assert.equal(requests, 1, 'um pedido');
    assert.equal(messages, 1, 'uma mensagem');
  } finally { await cleanup(personId, outboxId); }
});
