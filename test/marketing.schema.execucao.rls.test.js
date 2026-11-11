'use strict';

// M9-D401 — schema marketing parte 2 (existência, RLS, idempotência e supressão). Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');

const { sequelize } = require('../src/models');
const {
  TABLES, base, expectDbError, mkAutoVersion, mkFlow, mkJob, mkRun, mkVersion, popular, prepararTenants, q, sha, uid,
} = require('./helpers/marketingExecucao');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { empresaPropria } = require('./helpers/empresaPropria');

let tenantA;
let tenantB;
let vazia; // empresa própria do teste de isolamento, no grupo de B: nenhum outro arquivo grava nela (as linhas que outros commitam na empresa B não entram na conta)

before(async () => {
  ({ tenantA, tenantB } = await prepararTenants());
  vazia = await empresaPropria(tenantB);
});

after(async () => {
  await vazia.remover();
  await sequelize.close();
});

test('migration_cria_9_tabelas_com_rls', async () => {
  const tabelas = (await q("SELECT c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'marketing' AND c.relkind = 'r'")).map((r) => r.n);
  for (const t of TABLES) assert.ok(tabelas.includes(t), `falta marketing.${t}`);

  for (const tabela of TABLES) {
    const cols = await q("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = :t", { t: tabela });
    const nomes = cols.map((c) => c.column_name);
    for (const b of ['id', 'group_id', 'company_id', 'created_at']) assert.ok(nomes.includes(b), `${tabela} sem ${b}`);
    for (const nn of ['group_id', 'company_id']) assert.equal(cols.find((c) => c.column_name === nn).is_nullable, 'NO');
    const [r] = await q(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
              has_table_privilege('nayara_runtime', c.oid, 'SELECT') AS sel, has_table_privilege('nayara_runtime', c.oid, 'INSERT') AS ins
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'marketing' AND c.relname = :t`, { t: tabela });
    assert.equal(r.relrowsecurity, true, `${tabela}: RLS`);
    assert.equal(r.relforcerowsecurity, true, `${tabela}: FORCE RLS`);
    assert.ok(r.politicas >= 1, `${tabela}: política`);
    assert.ok(r.sel && r.ins, `${tabela}: GRANT ao nayara_runtime`);
    const idx = await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'marketing' AND tablename = :t", { t: tabela });
    assert.ok(idx.length >= 2, `${tabela} precisa de índices além da PK`);
  }

  const esperadas = {
    publication_jobs: ['content_version_id', 'channel', 'adapter_code', 'connection_id', 'status', 'idempotency_key', 'scheduled_at', 'attempts', 'next_attempt_at', 'external_post_id', 'last_error_code'],
    publication_results: ['job_id', 'attempt_no', 'outcome', 'external_post_id', 'external_url', 'provider_status', 'metrics_json', 'response_redacted_json', 'occurred_at'],
    automation_flows: ['code', 'name', 'owner_user_id', 'risk_level', 'status', 'published_version_id', 'kill_switch_active', 'kill_switch_at', 'kill_switch_by', 'kill_switch_reason'],
    automation_versions: ['flow_id', 'version_no', 'trigger_type', 'trigger_config', 'conditions', 'actions', 'cooldown', 'frequency_cap', 'valid_from', 'valid_until', 'status', 'risk_level', 'content_hash'],
    automation_runs: ['automation_version_id', 'trigger_event_id', 'subject_type', 'subject_id', 'correlation_id', 'idempotency_key', 'status', 'blocked_reason', 'policy_trace', 'next_due_at', 'actions_result', 'started_at', 'finished_at'],
    suppression_list: ['person_id', 'address_hash', 'channel', 'purpose', 'reason', 'source', 'active', 'expires_at', 'lifted_by', 'lifted_at'],
    tracking_links: ['campaign_id', 'content_item_id', 'short_code', 'target_url', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'channel', 'signature', 'expires_at', 'status'],
    attribution_events: ['person_id', 'opportunity_id', 'campaign_id', 'tracking_link_id', 'event_type', 'touch_roles', 'evidence_json', 'valid', 'occurred_at'],
    review_requests: ['person_id', 'source_entity_type', 'source_entity_id', 'satisfaction_score', 'platform', 'public_rating', 'completed_at', 'status', 'feedback_case_id', 'channel', 'sent_at'],
  };
  for (const [tabela, colunas] of Object.entries(esperadas)) {
    const nomes = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = :t", { t: tabela })).map((c) => c.column_name);
    for (const c of colunas) assert.ok(nomes.includes(c), `${tabela} sem a coluna ${c}`);
  }
});

test('rls_isola_as_9_tabelas_entre_empresas_e_sem_contexto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { hasPerson } = await popular(tenantA, tx);
    for (const tabela of TABLES) {
      if (tabela === 'review_requests' && !hasPerson) continue;
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.ok(n >= 1, `empresa A deve ver as suas linhas em ${tabela}`);
    }
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: vazia.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vazia.companyId }, transaction: tx });
    for (const tabela of TABLES) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.equal(n, 0, `outra empresa (do teste, sem dados) não pode ver nada de ${tabela}`);
    }
    await expectDbError(tx, `INSERT INTO marketing.suppression_list (group_id, company_id, address_hash, channel, reason, source, active)
      VALUES (:g, :c, :h, 'EMAIL', 'OPT_OUT', 'x', true)`, { ...base(tenantA), h: sha('z') }, /row-level security/i);
    await sequelize.query("SELECT set_config('app.group_id', '', true), set_config('app.company_id', '', true)", { transaction: tx });
    for (const tabela of TABLES) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.equal(n, 0, `${tabela} sem contexto deve ser vazia`);
    }
  });
});

test('unique_idempotency_key_da_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ver = await mkAutoVersion(tenantA, tx, await mkFlow(tenantA, tx));
    const key = `run:${uid()}`;
    await mkRun(tenantA, tx, ver, { key });
    await expectDbError(tx, `INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, correlation_id, idempotency_key, status)
      VALUES (:g, :c, :v, :cid, :k, 'STARTED')`, { ...base(tenantA), v: ver, cid: uid(), k: key }, /idempotency/i);
    // Mesma chave de publicação também é única.
    const { versionId } = await mkVersion(tenantA, tx);
    const jobKey = `pub:${versionId}:SITE:2026-11-01T12:00:00.000Z`;
    await mkJob(tenantA, tx, { versionId, key: jobKey });
    await expectDbError(tx, `INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
      VALUES (:g, :c, :v, 'SITE', 'site-cms', 'PENDING', :k, now())`, { ...base(tenantA), v: versionId, k: jobKey }, /idempotency/i);
    // Formato da chave de publicação.
    await expectDbError(tx, `INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
      VALUES (:g, :c, :v, 'SITE', 'site-cms', 'PENDING', 'qualquer', now())`, { ...base(tenantA), v: versionId }, /idempotency|chk/i);
  });
});

test('corrida_de_duas_conexoes_na_mesma_idempotency_key', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
    t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
    return;
  }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const key = `run:${uid()}`;
  let verId;
  let flowId;
  try {
    await sequelize.transaction(async (tx) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction: tx });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction: tx });
      flowId = await mkFlow(tenantA, tx);
      verId = await mkAutoVersion(tenantA, tx, flowId);
    });
    const insere = async (hold) => {
      const tx = await sequelize.transaction();
      try {
        await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction: tx });
        await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction: tx });
        await sequelize.query(`INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, correlation_id, idempotency_key, status)
          VALUES (:g, :c, :v, :cid, :k, 'STARTED')`, { replacements: { ...base(tenantA), v: verId, cid: uid(), k: key }, transaction: tx });
        if (hold) await new Promise((r) => setTimeout(r, 400));
        await tx.commit();
        return 'ok';
      } catch (e) {
        await tx.rollback();
        return e.parent?.code || e.message;
      }
    };
    const [a, b] = await Promise.all([insere(true), (async () => { await new Promise((r) => setTimeout(r, 100)); return insere(false); })()]);
    assert.deepEqual([a, b].sort(), ['23505', 'ok']);
    const [[{ n }]] = await admin.query('SELECT count(*)::int AS n FROM marketing.automation_runs WHERE idempotency_key = :k', { replacements: { k: key } });
    assert.equal(n, 1);
  } finally {
    await admin.query('DELETE FROM marketing.automation_runs WHERE idempotency_key = :k', { replacements: { k: key } }).catch(() => {});
    if (verId) await admin.query('DELETE FROM marketing.automation_versions WHERE id = :v', { replacements: { v: verId } }).catch(() => {});
    if (flowId) await admin.query('DELETE FROM marketing.automation_flows WHERE id = :f', { replacements: { f: flowId } }).catch(() => {});
    await admin.close();
  }
});

test('supressao_ativa_unica_por_endereco_canal_finalidade', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const h = sha('carlos@exemplo.test');
    const ins = `INSERT INTO marketing.suppression_list (group_id, company_id, address_hash, channel, purpose, reason, source, active)
      VALUES (:g, :c, :h, :ch, :p, :r, 'QA-M9', :a)`;
    const r = (over) => ({ ...base(tenantA), h, ch: 'WHATSAPP', p: null, r: 'OPT_OUT', a: true, ...over });
    await q(ins, r(), tx);
    await expectDbError(tx, ins, r(), /suppression|unique|duplicate/i);
    await q(ins, r({ p: 'MARKETING' }), tx); // finalidade específica convive com a geral
    await expectDbError(tx, ins, r({ p: 'MARKETING' }), /suppression|unique|duplicate/i);
    await q(ins, r({ ch: 'EMAIL' }), tx); // outro canal
    await q(ins, r({ a: false }), tx); // inativos não contam
    await q(ins, r({ a: false }), tx);
    await expectDbError(tx, ins, r({ r: 'OUTRO' }), /reason/i);
    await expectDbError(tx, ins, r({ h: 'carlos@exemplo.test' }), /address_hash|hash/i); // endereço em claro é recusado
    // Outra empresa pode ter o mesmo endereço.
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    await q(ins, { ...r(), ...base(tenantB) }, tx);
  });
});

