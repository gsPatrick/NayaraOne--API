'use strict';

// M9-D607 — o worker ligado ao outbox real: lote de 100 eventos registra uma única linha de refresh e 5 falhas levam à DLQ e a DEGRADED.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env607 = require('../_helpers/m9d607Env');
const { publishDomainEvent } = require('../../../src/engines/events/outbox');
const { dispatchPendingEventsForCompany } = require('../../../src/engines/events/outbox-dispatcher');

const { inTx, addSource } = env607;
let env;

before(async () => { env = await env607.setup(); });
after(() => env607.teardown(env));

const publish = (account, n) => inTx(env.tenantA, { commit: true }, (tx) => publishDomainEvent({
  groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, aggregateType: 'M9D607', aggregateId: crypto.randomUUID(), eventType: env.settledType,
  payload: { accountId: account }, idempotencyKey: `${env.settledType}:${account}:${n}`,
}, tx));
const dispatch = () => dispatchPendingEventsForCompany({ id: env.tenantA.groupId }, { id: env.tenantA.companyId }, { limit: 1000 });

test('m9d607 um lote de 100 eventos grava uma única linha em read_model_refreshes', async () => {
  const accounts = Array.from({ length: 10 }, (_, i) => `lote-${env607.sfx()}-${i}`);
  for (const acc of accounts) await addSource(env, env.tenantA, acc, '5.00');
  for (let n = 0; n < 10; n += 1) for (const acc of accounts) await publish(acc, n);
  const result = await dispatch();
  assert.ok(result.dispatched >= 100, 'os 100 eventos do teste (mais algum pendente de outros testes) saíram no mesmo lote');
  const [rows] = await env.admin.query(`SELECT "trigger", status, rows_upserted FROM analytics.read_model_refreshes WHERE read_model = :m`, { replacements: { m: env.model } });
  assert.equal(rows.length, 1, 'uma linha por lote, não uma por evento');
  assert.deepEqual([rows[0].trigger, rows[0].status, rows[0].rows_upserted], ['EVENT', 'SUCCEEDED', 100]);
  const [[applied]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE read_model = :m', { replacements: { m: env.model } });
  assert.equal(applied.n, 100);
});

test('m9d607 5 falhas levam à DLQ e marcam DEGRADED', async () => {
  const acc = `quebra-${env607.sfx()}`;
  await addSource(env, env.tenantA, acc, '9.00');
  env.failAccounts.add(acc);
  const ev = await publish(acc, 0);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await env.admin.query('UPDATE integration.outbox_events SET next_retry_at = NULL WHERE id = :id', { replacements: { id: ev.id } });
    await dispatch();
  }
  const [[row]] = await env.admin.query('SELECT status, retry_count FROM integration.outbox_events WHERE id = :id', { replacements: { id: ev.id } });
  assert.deepEqual([row.status, row.retry_count], ['DEAD_LETTER', 5]);
  const [[degraded]] = await env.admin.query(`SELECT status, error_code, last_source_event_id FROM analytics.read_model_refreshes WHERE read_model = :m AND status = 'DEGRADED' ORDER BY started_at DESC LIMIT 1`, { replacements: { m: env.model } });
  assert.deepEqual([degraded.status, degraded.error_code, degraded.last_source_event_id], ['DEGRADED', 'M9D607_FONTE', ev.id]);
  const [[applied]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE read_model = :m AND source_event_id = :e', { replacements: { m: env.model, e: ev.id } });
  assert.equal(applied.n, 0, 'nenhuma das 5 tentativas deixou o evento marcado como aplicado');
  env.failAccounts.delete(acc);
});
