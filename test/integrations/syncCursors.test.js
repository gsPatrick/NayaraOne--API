'use strict';

// Marco 9, M9-D208 — integration.sync_cursors: cursor transacional, lease, STALLED e alerta de sync parado.
// Os ciclos COMMITAM (lease e cursor precisam ser vistos por outro worker): rodar em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 test/integrations/syncCursors.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../testHelpers');
const { Group, Company, OutboxEvent, AuditLog, IntegrationConnection, IntegrationProvider, IntegrationSyncCursor } = require('../../src/models');
const registry = require('../../src/features/integrations/registry/registry.service');
const settingsService = require('../../src/features/settings/settings.service');
const { publishDomainEvent } = require('../../src/engines/events/outbox');
const { runSyncCycle } = require('../../src/features/integrations/sync/sync.runner');
const { detectStalledSyncs } = require('../../src/features/integrations/sync/sync.stalled');

let tenant;
let ctx;
let otherTenant;
const ativas = [];
const PREFIXO = `qa-m9-d208-${uniqueSuffix()}`;

async function comTenant(t0, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: t0.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: t0.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: t0.userId }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
const commit = (fn) => comTenant(tenant, fn);

async function config(chave, valor) {
  await commit((t) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t));
}

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  const grupoB = await Group.findOne({ where: { name: 'CI — Grupo Fictício B' } });
  if (grupoB) {
    const empresaB = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupoB.id }, transaction: t });
      return Company.findOne({ where: { groupId: grupoB.id, name: 'CI — Empresa Fictícia B' }, transaction: t });
    });
    if (empresaB) otherTenant = { groupId: grupoB.id, companyId: empresaB.id, userId: tenant.userId };
  }
  await config('integration.admin.mfa_on_prod_connection_change', false);
});

after(async () => {
  await commit(async (t) => {
    await sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'integration.sync.%'", { replacements: { c: tenant.companyId }, transaction: t });
  });
  await sequelize.close();
});

/** Conexão ACTIVE de um domínio; desativa a anterior do mesmo fornecedor (uma ativa por empresa/fornecedor/ambiente). */
async function conexao(domain = 'BANK') {
  const provider = await IntegrationProvider.findOne({ where: { domain, status: 'ACTIVE', sandboxAvailable: true } });
  assert.ok(provider, `sem fornecedor sandbox do domínio ${domain}`);
  return commit(async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND environment = 'SANDBOX' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId, p: provider.code }, transaction: t });
    const c = await registry.createConnection({ providerCode: provider.code, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}` }, ctx, t);
    await sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { replacements: { id: c.id }, transaction: t });
    ativas.push(c.id);
    return c;
  });
}

const cursorDe = (connectionId, stream) => commit((t) => IntegrationSyncCursor.findOne({ where: { connectionId, stream }, transaction: t }));
const contaItens = (run) => commit((t) => OutboxEvent.count({ where: { eventType: 'qa_m9.sync.item', aggregateType: run }, transaction: t }));

/** Fonte em memória: itens "ext-0001"..; grava no domínio (outbox) de forma idempotente pelo id externo. */
function fonte(run, total, { falhaNoItem = null, falhaNaPagina = null, onFetch, espera } = {}) {
  const ids = Array.from({ length: total }, (_, i) => `ext-${String(i + 1).padStart(4, '0')}`);
  const chamadas = [];
  return {
    chamadas,
    async fetchPage({ cursorValue, since, pageSize }) {
      chamadas.push({ cursorValue, since });
      if (onFetch) onFetch({ cursorValue, since });
      if (espera) await espera;
      const inicio = /^\d+$/.test(cursorValue || '') ? Number(cursorValue) : 0;
      const items = ids.slice(inicio, inicio + pageSize);
      const fim = inicio + items.length;
      return { items, nextCursor: String(fim), done: fim >= total };
    },
    async applyItems(items, { transaction }) {
      let novos = 0;
      let n = 0;
      for (const id of items) {
        n += 1;
        if (falhaNoItem && n === falhaNoItem && !(falhaNaPagina && chamadas.length !== falhaNaPagina)) throw new Error('queda simulada');
        const key = `${run}:${id}`;
        const antes = await OutboxEvent.count({ where: { idempotencyKey: key }, transaction });
        await publishDomainEvent({ groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: run, aggregateId: tenant.userId, eventType: 'qa_m9.sync.item', payload: { id }, idempotencyKey: key }, transaction);
        if (!antes) novos += 1;
      }
      return novos;
    },
  };
}

const ciclo = (c, stream, src, extra = {}) => runSyncCycle({ connectionId: c.id, stream, workerId: `w-${uniqueSuffix()}`, origin: 'SCHEDULER', ...extra }, ctx, src);

test('sync_cursor_retomado_sem_perda', async () => {
  await config('integration.sync.page_size', 200);
  const c = await conexao();
  const run = `${PREFIXO}-a`;
  const r1 = await ciclo(c, 'bank.statement', fonte(run, 200, { falhaNoItem: 121 }));
  assert.equal(r1.status, 'FAILED');
  const c1 = await cursorDe(c.id, 'bank.statement');
  assert.equal(c1.cursorValue, null, 'o cursor não avança sem gravar');
  assert.equal(c1.status, 'FAILED');
  assert.equal(c1.consecutiveFailures, 1);
  assert.equal(await contaItens(run), 0, 'a página inteira reverteu');

  const r2 = await ciclo(c, 'bank.statement', fonte(run, 200));
  assert.equal(r2.status, 'IDLE');
  assert.equal(r2.itemsWritten, 200);
  assert.equal(await contaItens(run), 200, '200 itens, 0 duplicados');
  const c2 = await cursorDe(c.id, 'bank.statement');
  assert.equal(c2.cursorValue, '200');
  assert.equal(Number(c2.itemsSyncedTotal), 200);
  assert.equal(c2.consecutiveFailures, 0);
  assert.equal(c2.leaseOwner, null);
  const audit = await commit((t) => AuditLog.count({ where: { entityType: 'IntegrationSyncCursor', entityId: c2.id }, transaction: t }));
  assert.ok(audit >= 2, 'mudanças de cursor e de status auditadas');
});

test('sync_cursor_retoma_do_checkpoint_da_pagina_anterior', async () => {
  await config('integration.sync.page_size', 50);
  const c = await conexao();
  const run = `${PREFIXO}-b`;
  const r1 = await ciclo(c, 'bank.statement', fonte(run, 120, { falhaNoItem: 10, falhaNaPagina: 2 }));
  assert.equal(r1.status, 'FAILED');
  assert.equal((await cursorDe(c.id, 'bank.statement')).cursorValue, '50', 'a página 1 ficou gravada e o cursor parou nela');
  assert.equal(await contaItens(run), 50);
  const src = fonte(run, 120);
  const r2 = await ciclo(c, 'bank.statement', src);
  assert.equal(src.chamadas[0].cursorValue, '50', 'retoma depois do último checkpoint');
  assert.equal(r2.itemsWritten, 70);
  assert.equal(await contaItens(run), 120);
});

test('sync_cursor_sem_duplicata', async () => {
  await config('integration.sync.page_size', 200);
  const c = await conexao();
  const run = `${PREFIXO}-c`;
  await ciclo(c, 'bank.statement', fonte(run, 30));
  const r2 = await ciclo(c, 'bank.statement', fonte(run, 30));
  assert.equal(r2.status, 'IDLE');
  assert.equal(r2.itemsWritten, 0, 'segundo ciclo sem novidade não grava nada');
  assert.equal(await contaItens(run), 30);
  // Releitura forçada (cursor voltou): a idempotência por id externo impede duplicata.
  await commit((t) => sequelize.query("UPDATE integration.sync_cursors SET cursor_value = '10' WHERE connection_id = :c", { replacements: { c: c.id }, transaction: t }));
  const r3 = await ciclo(c, 'bank.statement', fonte(run, 30));
  assert.equal(r3.itemsWritten, 0);
  assert.equal(await contaItens(run), 30);
});

test('sync_lease_expirado_assumido', async () => {
  const c = await conexao();
  const run = `${PREFIXO}-d`;
  await ciclo(c, 'bank.statement', fonte(run, 5));
  await commit((t) => sequelize.query("UPDATE integration.sync_cursors SET status = 'RUNNING', lease_owner = 'worker-morto', lease_expires_at = now() - interval '1 minute' WHERE connection_id = :c", { replacements: { c: c.id }, transaction: t }));
  const r = await ciclo(c, 'bank.statement', fonte(run, 8));
  assert.equal(r.status, 'IDLE');
  assert.equal((await cursorDe(c.id, 'bank.statement')).cursorValue, '8');
  // Lease ainda válido de outro worker: recusa 409.
  await commit((t) => sequelize.query("UPDATE integration.sync_cursors SET status = 'RUNNING', lease_owner = 'worker-vivo', lease_expires_at = now() + interval '5 minutes' WHERE connection_id = :c", { replacements: { c: c.id }, transaction: t }));
  await assert.rejects(ciclo(c, 'bank.statement', fonte(run, 8)), (e) => e.code === 'INTEGRATION_SYNC_ALREADY_RUNNING' && e.statusCode === 409);
});

test('sync_lease_exclusivo', async () => {
  const c = await conexao();
  const run = `${PREFIXO}-e`;
  let liberar;
  const portao = new Promise((resolve) => { liberar = resolve; });
  const a = ciclo(c, 'bank.statement', fonte(run, 10, { espera: portao }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(ciclo(c, 'bank.statement', fonte(run, 10)), (e) => e.code === 'INTEGRATION_SYNC_ALREADY_RUNNING');
  liberar();
  const r = await a;
  assert.equal(r.status, 'IDLE');
  assert.equal(await contaItens(run), 10, 'um só worker executou');
});

test('sync_overlap_timestamp', async () => {
  await config('integration.sync.overlap_s', 60);
  const c = await conexao();
  const run = `${PREFIXO}-f`;
  const marco = '2026-10-28T10:00:00.000Z';
  await commit((t) => IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: c.id, stream: 'portal.listing_status', cursorKind: 'TIMESTAMP', cursorValue: marco }, { transaction: t }));
  const src = fonte(run, 3);
  await ciclo(c, 'portal.listing_status', src);
  assert.equal(src.chamadas[0].since.toISOString(), '2026-10-28T09:59:00.000Z', 'recomeça 60 s antes do cursor');
  await ciclo(c, 'portal.listing_status', fonte(run, 3));
  assert.equal(await contaItens(run), 3, 'itens repetidos descartados por id externo');
  await config('integration.sync.overlap_s', 120);
  await commit((t) => sequelize.query("UPDATE integration.sync_cursors SET cursor_value = :v WHERE connection_id = :c", { replacements: { v: marco, c: c.id }, transaction: t }));
  const src2 = fonte(run, 3);
  await ciclo(c, 'portal.listing_status', src2);
  assert.equal(src2.chamadas[0].since.toISOString(), '2026-10-28T09:58:00.000Z', 'a janela é parâmetro do administrador');
});

test('sync_stalled_gera_alerta', async () => {
  const banco = await conexao('BANK');
  const social = await conexao('SOCIAL');
  const vinte = "now() - interval '20 minutes'";
  await commit(async (t) => {
    for (const [con, stream] of [[banco, 'bank.statement'], [social, 'social.posts']]) {
      await IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: con.id, stream }, { transaction: t });
      await sequelize.query(`UPDATE integration.sync_cursors SET last_success_at = ${vinte} WHERE connection_id = :c`, { replacements: { c: con.id }, transaction: t });
    }
  });
  const achados = await commit((t) => detectStalledSyncs(ctx, t));
  const ids = achados.map((x) => x.connectionId);
  assert.ok(ids.includes(banco.id), 'BANK (CRITICAL, 15 min) sem sucesso há 20 min alerta');
  assert.ok(!ids.includes(social.id), 'SOCIAL (LOW, 1440 min) não alerta');
  const ev = await commit((t) => OutboxEvent.count({ where: { eventType: 'integration.sync.stalled', aggregateId: achados.find((x) => x.connectionId === banco.id).cursorId }, transaction: t }));
  assert.equal(ev, 1);
  await commit((t) => detectStalledSyncs(ctx, t));
  const ev2 = await commit((t) => OutboxEvent.count({ where: { eventType: 'integration.sync.stalled', aggregateId: achados.find((x) => x.connectionId === banco.id).cursorId }, transaction: t }));
  assert.equal(ev2, 1, 'o mesmo atraso não gera alerta repetido');
  // O limite é parâmetro: com 30 min para CRITICAL, 20 min deixa de alertar.
  await config('integration.sync.stalled_after_minutes.CRITICAL', 30);
  const depois = await commit((t) => detectStalledSyncs(ctx, t));
  assert.ok(!depois.map((x) => x.connectionId).includes(banco.id));
  await commit((t) => sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.sync.stalled_after_minutes.CRITICAL'", { replacements: { c: tenant.companyId }, transaction: t }));
});

test('sync_stalled_so_sai_por_retry_humano', async () => {
  await config('integration.sync.failures_to_stall', 2);
  const c = await conexao();
  const run = `${PREFIXO}-g`;
  const quebrada = () => fonte(run, 5, { falhaNoItem: 1 });
  assert.equal((await ciclo(c, 'bank.statement', quebrada())).status, 'FAILED');
  assert.equal((await ciclo(c, 'bank.statement', quebrada())).status, 'STALLED');
  const parado = await cursorDe(c.id, 'bank.statement');
  assert.equal(parado.status, 'STALLED');
  assert.equal(parado.consecutiveFailures, 2);
  assert.ok(await commit((t) => OutboxEvent.count({ where: { eventType: 'integration.sync.stalled', aggregateId: parado.id }, transaction: t })) >= 1, 'virar STALLED dispara alerta');

  const src = fonte(run, 5);
  const r = await ciclo(c, 'bank.statement', src);
  assert.equal(r.status, 'SKIPPED', 'o agendador não executa STALLED');
  assert.equal(src.chamadas.length, 0);

  // Retry humano que falha: FAILED, contando de zero (1, e não 3).
  const falha = await ciclo(c, 'bank.statement', quebrada(), { origin: 'HUMAN_RETRY' });
  assert.equal(falha.status, 'FAILED');
  assert.equal((await cursorDe(c.id, 'bank.statement')).consecutiveFailures, 1);
  await ciclo(c, 'bank.statement', quebrada());
  assert.equal((await cursorDe(c.id, 'bank.statement')).status, 'STALLED');

  const ok = await ciclo(c, 'bank.statement', fonte(run, 5), { origin: 'HUMAN_RETRY' });
  assert.equal(ok.status, 'IDLE');
  const fim = await cursorDe(c.id, 'bank.statement');
  assert.equal(fim.status, 'IDLE');
  assert.equal(fim.consecutiveFailures, 0);
  assert.equal(await contaItens(run), 5);
});

test('sync_rls_isolamento', async (t) => {
  if (!otherTenant) return t.skip('só há uma empresa neste banco');
  const c = await conexao();
  await ciclo(c, 'bank.statement', fonte(`${PREFIXO}-h`, 3));
  const visto = await comTenant(otherTenant, (tx) => IntegrationSyncCursor.count({ where: { connectionId: c.id }, transaction: tx }));
  assert.equal(visto, 0, 'a empresa B não vê o cursor da A');
  await comTenant(otherTenant, async (tx) => {
    const [, meta] = await sequelize.query("UPDATE integration.sync_cursors SET status = 'STALLED' WHERE connection_id = :c", { replacements: { c: c.id }, transaction: tx });
    assert.equal(meta.rowCount, 0);
    await assert.rejects(IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: c.id, stream: 'invasao' }, { transaction: tx }));
  });
  assert.equal((await cursorDe(c.id, 'bank.statement')).status, 'IDLE');
});

test('sync_tabela_com_rls_force_e_constraints', async () => {
  const [[row]] = await sequelize.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname = 'sync_cursors'");
  assert.equal(row.relrowsecurity, true);
  assert.equal(row.relforcerowsecurity, true);
  const c = await conexao();
  await commit((t) => IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: c.id, stream: 'x.unico' }, { transaction: t }));
  await assert.rejects(commit((t) => IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: c.id, stream: 'x.unico' }, { transaction: t })), /unique|Validation/i);
  await assert.rejects(commit((t) => sequelize.query("UPDATE integration.sync_cursors SET status = 'XX' WHERE connection_id = :c", { replacements: { c: c.id }, transaction: t })), /check/i);
  assert.equal(IntegrationConnection.name, 'IntegrationConnection');
});
