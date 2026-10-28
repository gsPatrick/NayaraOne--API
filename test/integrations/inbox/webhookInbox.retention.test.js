'use strict';

// Marco 9, M9-D203 — retenção da caixa de entrada e migração do Correspondente.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize, comTenant, carregarTenants, receber, prefixo } = require('./inboxHelpers');
const { IntegrationWebhookInbox } = require('../../../src/models');
const { purgeWebhookInbox } = require('../../../src/features/integrations/inbox');
const { recordError } = require('../../../src/features/integrations/errors');
const { BACKFILL_SQL } = require('../../../migrations/20260101000658-create-integration-webhook-inbox');

let tenant;
const PROV = 'qa-m9-d203-ret';
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });

before(async () => { ({ tenant } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

async function envelhecer(eventId, dias, patch = {}) {
  await comTenant(tenant, (t) => IntegrationWebhookInbox.update(
    { receivedAt: new Date(Date.now() - dias * 86400000), ...patch },
    { where: { providerCode: PROV, externalEventId: eventId }, transaction: t }
  ));
}
const ler = (eventId) => comTenant(tenant, (t) => IntegrationWebhookInbox.findOne({ where: { providerCode: PROV, externalEventId: eventId }, transaction: t }));

test('inbox_retencao_anula_raw', async () => {
  const novo = prefixo(); const velho = prefixo(); const muitoVelho = prefixo(); const dlq = prefixo(); const dlqComErro = prefixo(); const dlqRecente = prefixo();
  for (const id of [novo, velho, muitoVelho, dlq, dlqComErro, dlqRecente]) await receber(tenant, PROV, id);
  await envelhecer(novo, 29, { status: 'PROCESSED' });
  await envelhecer(velho, 31, { status: 'PROCESSED' });
  await envelhecer(muitoVelho, 91, { status: 'PROCESSED' });
  await envelhecer(dlq, 91, { status: 'DEAD_LETTER', deadLetterReason: 'ATTEMPTS_EXHAUSTED' });
  await envelhecer(dlqComErro, 91, { status: 'DEAD_LETTER', deadLetterReason: 'ATTEMPTS_EXHAUSTED' });
  await envelhecer(dlqRecente, 6, { status: 'DEAD_LETTER', deadLetterReason: 'ATTEMPTS_EXHAUSTED' });
  const comErro = await ler(dlqComErro);
  await comTenant(tenant, (t) => recordError(ctx(), {
    providerCode: PROV, source: 'WEBHOOK', errorClass: 'UNKNOWN', errorCode: 'ATTEMPTS_EXHAUSTED', sourceRefId: comErro.id, message: 'Falhou.',
  }, t));
  const hashVelho = (await ler(velho)).payloadHash;

  const r = await comTenant(tenant, (t) => purgeWebhookInbox(ctx(), t));
  assert.ok(r.rawCleared >= 1 && r.deleted >= 2);

  assert.ok((await ler(novo)).payloadRaw, 'com 29 dias o corpo permanece');
  const v = await ler(velho);
  assert.equal(v.payloadRaw, null, 'com 31 dias o corpo bruto é anulado');
  assert.equal(v.payload, null);
  assert.equal(v.payloadHash, hashVelho, 'o hash fica');
  assert.equal(await ler(muitoVelho), null, 'passados 90 dias a linha sai');
  assert.equal(await ler(dlq), null, 'DEAD_LETTER sem erro aberto também sai aos 90 dias');
  const presa = await ler(dlqComErro);
  assert.ok(presa, 'DEAD_LETTER com erro OPEN não é expurgada');
  assert.equal(presa.payloadRaw, null, 'mas o corpo já passou dos 7 dias');
  assert.ok((await ler(dlqRecente)).payloadRaw, 'DEAD_LETTER por tentativas guarda o corpo por 7 dias');
});

test('inbox_migracao_correspondente_idempotente', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) { t.skip('só no banco descartável'); return; }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const evento = prefixo();
  const caseId = '00000000-0000-4000-8000-0000000d2030';
  try {
    await admin.transaction(async (tx) => {
      await admin.query("SET LOCAL session_replication_role = 'replica'", { transaction: tx });
      await admin.query(
        `INSERT INTO correspondent.webhook_inbox (id, group_id, company_id, financing_case_id, provider_code, external_event_id, payload, received_at)
         VALUES (gen_random_uuid(), :g, :c, :fc, 'SANDBOX-QA', :e, '{"status":"ANALYSIS"}'::jsonb, now())`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, fc: caseId, e: evento }, transaction: tx }
      );
    });
    const contar = async () => (await admin.query(
      'SELECT count(*)::int AS n FROM integration.webhook_inbox WHERE external_event_id = :e', { replacements: { e: evento }, type: Sequelize.QueryTypes.SELECT }
    ))[0].n;
    await admin.query(BACKFILL_SQL);
    assert.equal(await contar(), 1);
    await admin.query(BACKFILL_SQL);
    assert.equal(await contar(), 1, 'rodar duas vezes não duplica');
    const [linha] = await admin.query(
      'SELECT status, signature_valid, headers_json, provider_code FROM integration.webhook_inbox WHERE external_event_id = :e', { replacements: { e: evento }, type: Sequelize.QueryTypes.SELECT }
    );
    assert.equal(linha.status, 'PROCESSED');
    assert.equal(linha.signature_valid, true);
    assert.equal(linha.headers_json.caseRef, caseId);
    assert.equal(linha.provider_code, 'sandbox-qa');
    // A tabela antiga é somente leitura (INSERT e UPDATE) para o runtime.
    await assert.rejects(comTenant(tenant, (tx) => sequelize.query(
      `INSERT INTO correspondent.webhook_inbox (id, group_id, company_id, financing_case_id, provider_code, external_event_id, payload)
       VALUES (gen_random_uuid(), :g, :c, :fc, 'x', 'y', '{}'::jsonb)`, { replacements: { g: tenant.groupId, c: tenant.companyId, fc: caseId }, transaction: tx }
    )), /somente leitura/);
  } finally {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('DELETE FROM correspondent.webhook_inbox WHERE external_event_id = :e', { replacements: { e: evento } });
    await admin.query('DELETE FROM integration.webhook_inbox WHERE external_event_id = :e', { replacements: { e: evento } });
    await admin.close();
  }
});
