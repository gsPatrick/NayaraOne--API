'use strict';

// Marco 9, M9-D204 — adequação de integration.outbox_events para publicar eventos internos aos adapters.
// Roda em banco descartável (os testes de despacho COMMITAM dados e depois apagam):
//   node scripts/withDisposableDb.js --port <porta> -- env ... node --test --test-concurrency=1 test/integrations/outboxAdequacao.test.js

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const { Group, Company, OutboxEvent } = require('../../src/models');
const AppError = require('../../src/utils/AppError');
const { publishDomainEvent } = require('../../src/engines/events/outbox');
const { dispatchPendingEventsForCompany } = require('../../src/engines/events/outbox-dispatcher');
const gateway = require('../../src/engines/events/dispatchGateway');
const settingsService = require('../../src/features/settings/settings.service');

let tenant;
const criados = [];

before(async () => {
  tenant = await getSeedTenant();
});

beforeEach(() => gateway.resetDispatchEnqueuer());

after(async () => {
  gateway.resetDispatchEnqueuer();
  if (criados.length && process.env.DATABASE_ADMIN_URL) {
    const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
    await admin.query('DELETE FROM integration.outbox_events WHERE id IN (:ids)', { replacements: { ids: criados } });
    await admin.close();
  }
  await comTenantCommit(async (t) => {
    await sequelize.query(`DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.outbox.backoff_ms'`, { replacements: { c: tenant.companyId }, transaction: t });
  });
  await sequelize.close();
});

async function comTenantCommit(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

function evento(over = {}) {
  return {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    aggregateType: 'Contract',
    aggregateId: tenant.userId,
    eventType: 'qa_m9.contrato_assinado',
    payload: { valor: '1250.00' },
    idempotencyKey: `qa-m9-d204:${uniqueSuffix()}`,
    ...over,
  };
}

async function publicaCommit(over) {
  const row = await comTenantCommit((t) => publishDomainEvent(evento(over), t));
  criados.push(row.id);
  return row;
}

async function recarrega(id) {
  return comTenantCommit((t) => OutboxEvent.findByPk(id, { transaction: t }));
}

async function despacha() {
  const group = await Group.findByPk(tenant.groupId);
  const company = await sequelize.transaction(async (ct) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: ct });
    return Company.findByPk(tenant.companyId, { transaction: ct });
  });
  return dispatchPendingEventsForCompany(group, company, { limit: 500 });
}

test('outbox_evento_com_destino_cria_dispatch', async () => {
  const chamadas = [];
  gateway.registerDispatchEnqueuer(async (args) => {
    chamadas.push(args);
    assert.ok(args.transaction, 'o dispatch nasce na transação do despacho (sem chamada externa)');
    return { dispatchId: 'fake-dispatch', status: 'PENDING' };
  });
  const row = await publicaCommit({ targetDomain: 'PORTAL' });
  const gravado = await recarrega(row.id);
  assert.equal(gravado.targetDomain, 'PORTAL');
  assert.equal(gravado.connectionId, null);

  const r1 = await despacha();
  const minhas = chamadas.filter((c) => c.outboxEventId === row.id);
  assert.equal(minhas.length, 1, 'exatamente 1 dispatch por evento');
  assert.equal(minhas[0].domain, 'PORTAL');
  assert.equal(minhas[0].companyId, tenant.companyId);
  assert.equal(minhas[0].aggregateType, 'Contract');
  assert.deepEqual(minhas[0].payload, { valor: '1250.00' });
  assert.ok(r1.published >= 1);
  assert.equal((await recarrega(row.id)).status, 'PUBLISHED');

  await despacha();
  assert.equal(chamadas.filter((c) => c.outboxEventId === row.id).length, 1, 'PUBLISHED não é despachado de novo');
});

test('outbox_evento_com_destino_falha_do_dispatch_mantem_pendente_e_reprocessa', async () => {
  gateway.registerDispatchEnqueuer(async () => {
    throw AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  });
  const row = await publicaCommit({ targetDomain: 'BANK' });
  await despacha();
  const depois = await recarrega(row.id);
  assert.equal(depois.status, 'PENDING', 'sem dispatch criado o evento continua PENDING');
  assert.equal(depois.retryCount, 1);
  assert.ok(depois.nextRetryAt > new Date());
});

test('outbox_evento_com_destino_sem_porta_de_dispatch_fica_pendente_sem_contar_tentativa', async () => {
  const row = await publicaCommit({ targetDomain: 'EMAIL' });
  const r = await despacha();
  const depois = await recarrega(row.id);
  assert.equal(depois.status, 'PENDING');
  assert.equal(depois.retryCount, 0);
  assert.ok(r.waiting >= 1);
});

test('outbox_evento_sem_destino_caminho_antigo', async () => {
  const ids = [];
  gateway.registerDispatchEnqueuer(async (a) => { ids.push(a.outboxEventId); return {}; });
  const row = await publicaCommit({});
  await despacha();
  assert.equal(ids.includes(row.id), false, 'evento interno não passa pelo dispatch');
  assert.equal((await recarrega(row.id)).status, 'DISPATCHED');
});

test('outbox_rollback_negocio_nao_deixa_evento', async () => {
  const chave = `qa-m9-d204:rollback:${uniqueSuffix()}`;
  await assert.rejects(
    comTenantCommit(async (t) => {
      await publishDomainEvent(evento({ idempotencyKey: chave, targetDomain: 'PORTAL' }), t);
      throw new Error('falha do negócio depois do publish');
    }),
    /falha do negócio/
  );
  const achado = await comTenantCommit((t) => OutboxEvent.findOne({ where: { idempotencyKey: chave }, transaction: t }));
  assert.equal(achado, null);
});

test('outbox_publish_fora_de_transacao_recusado', async () => {
  for (const tx of [undefined, null]) {
    await assert.rejects(publishDomainEvent(evento(), tx), (err) => {
      assert.equal(err.code, 'INTEGRATION_OUTBOX_TRANSACTION_REQUIRED');
      assert.equal(err.statusCode ?? err.status, 500);
      assert.match(err.message, /mesma transação do dado de negócio/);
      return true;
    });
  }
});

test('outbox_domain_de_destino_fora_do_catalogo_recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(publishDomainEvent(evento({ targetDomain: 'XPTO' }), transaction), (err) => err.code === 'INTEGRATION_OUTBOX_TARGET_DOMAIN_INVALID');
  });
});

test('outbox_republicar_mesma_chave_noop', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const e = evento({ targetDomain: 'PORTAL' });
    const a = await publishDomainEvent(e, transaction);
    const b = await publishDomainEvent({ ...e, payload: { valor: 'outro' } }, transaction);
    assert.equal(b.id, a.id, 'devolve o evento existente');
    const n = await OutboxEvent.count({ where: { idempotencyKey: e.idempotencyKey }, transaction });
    assert.equal(n, 1);
    assert.deepEqual((await OutboxEvent.findByPk(a.id, { transaction })).payloadJson, { valor: '1250.00' }, 'o primeiro vence');
  });
});

test('outbox_backoff_lido_do_parametro_do_administrador', async () => {
  await comTenantCommit((t) => settingsService.upsertSetting('integration.outbox.backoff_ms', '1000,2000', tenant, tenant.userId, t));
  gateway.registerDispatchEnqueuer(async () => { throw new Error('fornecedor fora'); });
  const row = await publicaCommit({ targetDomain: 'PORTAL' });
  const antes = Date.now();
  await despacha();
  const um = await recarrega(row.id);
  assert.equal(um.retryCount, 1);
  const espera = um.nextRetryAt.getTime() - antes;
  assert.ok(espera > 500 && espera < 5000, `1ª espera deve ser ~1 s (veio ${espera} ms)`);
  // força a próxima tentativa e esgota a lista de 2 passos: a 2ª falha vai para a DLQ.
  await comTenantCommit((t) => sequelize.query('UPDATE integration.outbox_events SET next_retry_at = now() - interval \'1 second\' WHERE id = :id', { replacements: { id: row.id }, transaction: t }));
  await despacha();
  const dois = await recarrega(row.id);
  assert.equal(dois.status, 'DEAD_LETTER');
  assert.match(dois.deadLetterReason, /fornecedor fora/);
});

test('outbox_backoff_invalido_recusado_na_configuracao', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const ruim of ['abc', '1000,,2000', '0,5', '-1', '1000;2000']) {
      await assert.rejects(settingsService.upsertSetting('integration.outbox.backoff_ms', ruim, tenant, tenant.userId, transaction), (err) => err.code === 'SETTING_INVALID_VALUE', ruim);
    }
  });
});

test('outbox_migration_aditiva_reversivel', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
    t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
    return;
  }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const migration = require(path.resolve(__dirname, '../../migrations/20260101000653-outbox-events-target-domain-connection.js'));
  const qi = admin.getQueryInterface();
  const colunas = async () => (await admin.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'integration' AND table_name = 'outbox_events' AND column_name IN ('connection_id','target_domain')"))[0];
  const indice = async () => (await admin.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'integration' AND tablename = 'outbox_events' AND indexname = 'outbox_events_status_next_retry_idx'"))[0].length;
  try {
    await admin.query("DELETE FROM integration.outbox_events WHERE idempotency_key LIKE 'qa-m9-d204:%'");
    const antes = (await admin.query('SELECT count(*)::int AS n FROM integration.outbox_events'))[0][0].n;
    const cols = await colunas();
    assert.equal(cols.length, 2);
    assert.ok(cols.every((c) => c.is_nullable === 'YES'), 'colunas nulas por padrão');
    assert.equal(await indice(), 1);
    await migration.up(qi); // idempotente
    await migration.down(qi);
    assert.equal((await colunas()).length, 0);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM integration.outbox_events'))[0][0].n, antes, 'down não perde linhas');
    await migration.up(qi);
    assert.equal((await colunas()).length, 2);
    // down recusa quando há dado nas colunas novas (perderia informação).
    const [{ id: gid }] = (await admin.query('SELECT id FROM core.groups LIMIT 1'))[0];
    const [{ id: cid }] = (await admin.query('SELECT id FROM core.companies WHERE group_id = :g LIMIT 1', { replacements: { g: gid } }))[0];
    await admin.query(`INSERT INTO integration.outbox_events (id, group_id, company_id, aggregate_type, aggregate_id, event_type, payload_json, idempotency_key, occurred_at, status, target_domain, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, 'X', gen_random_uuid(), 'qa_m9.down', '{}', :k, now(), 'PENDING', 'PORTAL', now(), now())`, { replacements: { g: gid, c: cid, k: `qa-m9-d204:down:${uniqueSuffix()}` } });
    await assert.rejects(migration.down(qi), /target_domain|connection_id/);
    await admin.query("DELETE FROM integration.outbox_events WHERE event_type = 'qa_m9.down'");
  } finally {
    await admin.close();
  }
});
