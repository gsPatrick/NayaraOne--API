'use strict';

// M9-D401 — schema "marketing", parte 2: publication_jobs, publication_results, automation_flows,
// automation_versions, automation_runs, suppression_list, tracking_links, attribution_events e review_requests,
// com RLS FORCE por grupo e empresa. Roda com a role de runtime (nayara_runtime, NOBYPASSRLS), em transação com
// rollback; corrida entre conexões e migration só no banco descartável (DISPOSABLE_DB=1 + DATABASE_ADMIN_URL).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Sequelize, QueryTypes } = require('sequelize');

const { sequelize, Group, Company } = require('../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');

const TABLES = [
  'publication_jobs', 'publication_results', 'automation_flows', 'automation_versions', 'automation_runs',
  'suppression_list', 'tracking_links', 'attribution_events', 'review_requests',
];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();

let tenantA;
let tenantB;

before(async () => {
  tenantA = await getSeedTenant();
  const groupB = await Group.findOne({ where: { name: 'CI — Grupo Fictício A' } });
  assert.ok(groupB, 'o seed de dois tenants precisa ter rodado (scripts/seed-ci-two-tenants.js)');
  const companyB = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: groupB.id }, transaction });
    return Company.findOne({ where: { groupId: groupB.id }, transaction });
  });
  assert.ok(companyB);
  tenantB = { groupId: groupB.id, companyId: companyB.id, userId: tenantA.userId };
});

after(async () => {
  await sequelize.close();
});

async function q(sql, replacements, transaction) {
  return sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
}

async function expectDbError(transaction, sql, replacements, matcher) {
  await sequelize.query('SAVEPOINT s1', { transaction });
  let err = null;
  try {
    await sequelize.query(sql, { replacements, transaction });
  } catch (e) {
    err = e;
  }
  await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction });
  assert.ok(err, 'o banco deveria ter recusado o comando');
  if (matcher) assert.match(`${err.parent?.constraint || ''} ${err.parent?.message || err.message}`, matcher);
  return err;
}

const base = (t) => ({ g: t.groupId, c: t.companyId });

// ---------- fábricas (cada uma devolve o id) ----------
async function mkTemplate(t, tx) {
  const [r] = await q(`INSERT INTO marketing.templates (group_id, company_id, code, version_no, kind, channel, status, body, content_hash)
    VALUES (:g, :c, :code, 1, 'CONTENT', 'SITE', 'DRAFT', 'x', :h) RETURNING id`, { ...base(t), code: `T-${uid().slice(0, 6)}`, h: sha('t') }, tx);
  return r.id;
}
async function mkVersion(t, tx) {
  const tpl = await mkTemplate(t, tx);
  const [item] = await q(`INSERT INTO marketing.content_items (group_id, company_id, type, title) VALUES (:g, :c, 'NEW_PROPERTY', 'QA-M9') RETURNING id`, base(t), tx);
  const [v] = await q(`INSERT INTO marketing.content_versions (group_id, company_id, content_item_id, version_no, body_json, template_id, template_version_no, content_hash)
    VALUES (:g, :c, :i, 1, '{}'::jsonb, :t, 1, :h) RETURNING id`, { ...base(t), i: item.id, t: tpl, h: sha('v') }, tx);
  return { versionId: v.id, itemId: item.id };
}
async function mkJob(t, tx, over = {}) {
  const { versionId } = over.versionId ? over : await mkVersion(t, tx);
  const key = over.key || `pub:${versionId}:SITE:2026-11-01T12:00:00.000Z`;
  const [r] = await q(`INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
    VALUES (:g, :c, :v, 'SITE', 'site-cms', 'PENDING', :k, '2026-11-01T12:00:00Z') RETURNING id`, { ...base(t), v: versionId, k: key }, tx);
  return r.id;
}
async function mkFlow(t, tx) {
  const [r] = await q(`INSERT INTO marketing.automation_flows (group_id, company_id, code, name, owner_user_id, risk_level, status)
    VALUES (:g, :c, :code, 'Fluxo QA-M9', :o, 'LOW', 'ACTIVE') RETURNING id`, { ...base(t), code: `F-${uid().slice(0, 6)}`, o: t.userId }, tx);
  return r.id;
}
async function mkAutoVersion(t, tx, flowId, status = 'DRAFT', no = 1) {
  const [r] = await q(`INSERT INTO marketing.automation_versions (group_id, company_id, flow_id, version_no, trigger_type, trigger_config, conditions, actions,
      cooldown, frequency_cap, status, risk_level, content_hash)
    VALUES (:g, :c, :f, :n, 'EVENT', '{"event":"lead.created"}'::jsonb, '[]'::jsonb, '[{"action_key":"a1","type":"SEND"}]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, :s, 'LOW', :h) RETURNING id`, { ...base(t), f: flowId, n: no, s: status, h: sha('av') }, tx);
  return r.id;
}
async function mkRun(t, tx, versionId, over = {}) {
  const [r] = await q(`INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, trigger_event_id, subject_type, subject_id,
      correlation_id, idempotency_key, status, next_due_at, actions_result)
    VALUES (:g, :c, :v, 'evt-1', 'PERSON', :sid, :cid, :k, :st, :due, CAST(:ar AS jsonb)) RETURNING id`,
  { ...base(t), v: versionId, sid: uid(), cid: uid(), k: over.key || `run:${uid()}`, st: over.status || 'STARTED', due: over.due || null,
    ar: JSON.stringify(over.actionsResult || []) }, tx);
  return r.id;
}

async function popular(t, tx) {
  const jobId = await mkJob(t, tx);
  await q(`INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, occurred_at) VALUES (:g, :c, :j, 1, 'SUCCESS', now())`, { ...base(t), j: jobId }, tx);
  const flowId = await mkFlow(t, tx);
  const verId = await mkAutoVersion(t, tx, flowId);
  await mkRun(t, tx, verId);
  await q(`INSERT INTO marketing.suppression_list (group_id, company_id, address_hash, channel, reason, source, active) VALUES (:g, :c, :h, 'EMAIL', 'OPT_OUT', 'QA-M9', true)`, { ...base(t), h: sha(uid()) }, tx);
  await q(`INSERT INTO marketing.tracking_links (group_id, company_id, short_code, target_url, channel, signature, status)
    VALUES (:g, :c, :s, 'https://exemplo.test/imovel', 'SITE', :sig, 'ACTIVE')`, { ...base(t), s: uid().slice(0, 10), sig: sha('sig') }, tx);
  await q(`INSERT INTO marketing.attribution_events (group_id, company_id, event_type, touch_roles, evidence_json, valid, occurred_at)
    VALUES (:g, :c, 'CLICK', '{FIRST,LAST}', '{"ip_hash":"x"}'::jsonb, true, now())`, base(t), tx);
  const [p] = await q('SELECT id FROM people.persons LIMIT 1', {}, tx);
  if (p) {
    await q(`INSERT INTO marketing.review_requests (group_id, company_id, person_id, source_entity_type, source_entity_id, status, channel)
      VALUES (:g, :c, :p, 'CONTRACT', :s, 'PENDING', 'EMAIL')`, { ...base(t), p: p.id, s: uid() }, tx);
  }
  return { hasPerson: !!p };
}

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
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    for (const tabela of TABLES) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.equal(n, 0, `empresa B não pode ver nada de ${tabela}`);
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

test('publication_results_e_append_only', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const jobId = await mkJob(tenantA, tx);
    const [{ id }] = await q(`INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, occurred_at)
      VALUES (:g, :c, :j, 1, 'FAILURE', now()) RETURNING id`, { ...base(tenantA), j: jobId }, tx);
    const e1 = await expectDbError(tx, "UPDATE marketing.publication_results SET outcome = 'SUCCESS' WHERE id = :id", { id }, /MKT_RESULT_APPEND_ONLY/);
    assert.equal(e1.parent.code, 'MK002');
    await expectDbError(tx, 'DELETE FROM marketing.publication_results WHERE id = :id', { id }, /MKT_RESULT_APPEND_ONLY|permission/i);
    await expectDbError(tx, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome) VALUES (:g, :c, :j, 2, 'TALVEZ')`,
      { ...base(tenantA), j: jobId }, /outcome/i);
    await expectDbError(tx, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome) VALUES (:g, :c, :j, 0, 'SUCCESS')`,
      { ...base(tenantA), j: jobId }, /attempt/i);
  });
});

test('response_redacted_nao_guarda_segredo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const jobId = await mkJob(tenantA, tx);
    const payload = {
      Authorization: 'Bearer abc.def.ghi', status: 'ok', max_tokens: 100,
      headers: { 'Set-Cookie': 'sid=1', 'content-type': 'application/json', 'X-Api-Key': 'k-123' },
      data: { access_token: 'EAAB123', refresh_token: 'r', client_secret: 's', password: 'p', nested: [{ apiKey: 'zzz' }, { id: 'post-1' }] },
      note: 'Bearer sk-live-xyz',
    };
    const [{ r }] = await q(`INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, response_redacted_json)
      VALUES (:g, :c, :j, 1, 'SUCCESS', CAST(:p AS jsonb)) RETURNING response_redacted_json AS r`, { ...base(tenantA), j: jobId, p: JSON.stringify(payload) }, tx);
    const txt = JSON.stringify(r);
    for (const segredo of ['abc.def.ghi', 'sid=1', 'k-123', 'EAAB123', 'sk-live-xyz', 'zzz']) assert.ok(!txt.includes(segredo), `vazou ${segredo}`);
    assert.equal(r.Authorization, '[REDIGIDO]');
    assert.equal(r.headers['Set-Cookie'], '[REDIGIDO]');
    assert.equal(r.headers['X-Api-Key'], '[REDIGIDO]');
    assert.equal(r.data.access_token, '[REDIGIDO]');
    assert.equal(r.data.nested[0].apiKey, '[REDIGIDO]');
    assert.equal(r.note, '[REDIGIDO]');
    // O que não é segredo permanece.
    assert.equal(r.status, 'ok');
    assert.equal(r.max_tokens, 100);
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.data.nested[1].id, 'post-1');
  });
});

test('versao_publicada_de_automacao_e_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const flow = await mkFlow(tenantA, tx);
    const draft = await mkAutoVersion(tenantA, tx, flow, 'DRAFT', 1);
    // Rascunho é editável.
    await q(`UPDATE marketing.automation_versions SET actions = '[{"action_key":"a2"}]'::jsonb WHERE id = :id`, { id: draft }, tx);
    await q("UPDATE marketing.automation_versions SET status = 'PUBLISHED' WHERE id = :id", { id: draft }, tx);
    for (const set of ["actions = '[]'::jsonb", "conditions = '[1]'::jsonb", "trigger_config = '{}'::jsonb", "cooldown = '{\"d\":1}'::jsonb",
      "frequency_cap = '{\"n\":1}'::jsonb", `content_hash = '${sha('outro')}'`, "risk_level = 'HIGH'", "valid_until = now()"]) {
      const err = await expectDbError(tx, `UPDATE marketing.automation_versions SET ${set} WHERE id = :id`, { id: draft }, /MKT_AUTOMATION_VERSION_IMMUTABLE/);
      assert.equal(err.parent.code, 'MK003');
    }
    await expectDbError(tx, "UPDATE marketing.automation_versions SET status = 'DRAFT' WHERE id = :id", { id: draft }, /MKT_AUTOMATION_VERSION_IMMUTABLE/);
    // A transição de estado continua permitida.
    await q("UPDATE marketing.automation_versions SET status = 'PAUSED' WHERE id = :id", { id: draft }, tx);
    await q("UPDATE marketing.automation_versions SET status = 'PUBLISHED' WHERE id = :id", { id: draft }, tx);
    await q("UPDATE marketing.automation_versions SET status = 'SUPERSEDED' WHERE id = :id", { id: draft }, tx);
    await expectDbError(tx, "UPDATE marketing.automation_versions SET actions = '[]'::jsonb WHERE id = :id", { id: draft }, /MKT_AUTOMATION_VERSION_IMMUTABLE/);
    // version_no único por fluxo.
    await expectDbError(tx, `INSERT INTO marketing.automation_versions (group_id, company_id, flow_id, version_no, trigger_type, actions, status, risk_level, content_hash)
      VALUES (:g, :c, :f, 1, 'EVENT', '[]'::jsonb, 'DRAFT', 'LOW', :h)`, { ...base(tenantA), f: flow, h: sha('x') }, /version/i);
    // O fluxo aponta para a versão publicada.
    await q('UPDATE marketing.automation_flows SET published_version_id = :v WHERE id = :f', { v: draft, f: flow }, tx);
  });
});

test('check_de_status_da_run_aceita_waiting_e_recusa_outro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ver = await mkAutoVersion(tenantA, tx, await mkFlow(tenantA, tx));
    for (const st of ['STARTED', 'COMPLETED', 'BLOCKED', 'FAILED']) await mkRun(tenantA, tx, ver, { status: st });
    const due = '2026-11-02T11:00:00Z';
    const acoes = [
      { action_key: 'a1', status: 'SCHEDULED', due_at: due, provider_ref: null, error_code: null },
      { action_key: 'a2', status: 'PENDING', due_at: null },
    ];
    const waiting = await mkRun(tenantA, tx, ver, { status: 'WAITING', due, actionsResult: acoes });
    await q(`UPDATE marketing.automation_runs SET policy_trace = '[{"passo":"consent","ok":true}]'::jsonb WHERE id = :id`, { id: waiting }, tx);
    const [lida] = await q('SELECT status, next_due_at, policy_trace FROM marketing.automation_runs WHERE id = :id', { id: waiting }, tx);
    assert.equal(lida.status, 'WAITING');
    assert.ok(lida.next_due_at);
    assert.equal(lida.policy_trace[0].passo, 'consent');
    const ins = (status, due2, ar) => ({ sql: `INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, correlation_id, idempotency_key, status, next_due_at, actions_result)
      VALUES (:g, :c, :v, :cid, :k, :st, :due, CAST(:ar AS jsonb))`, rep: { ...base(tenantA), v: ver, cid: uid(), k: `run:${uid()}`, st: status, due: due2, ar: JSON.stringify(ar) } });
    for (const bad of ['WAIT', 'PAUSED', 'DONE', 'waiting']) {
      const { sql, rep } = ins(bad, null, []);
      await expectDbError(tx, sql, rep, /status/i);
    }
    // WAITING exige next_due_at.
    { const { sql, rep } = ins('WAITING', null, acoes); await expectDbError(tx, sql, rep, /next_due|waiting/i); }
    // Status de ação fora do enum e formato fora de lista.
    { const { sql, rep } = ins('STARTED', null, [{ action_key: 'a1', status: 'OTHER' }]); await expectDbError(tx, sql, rep, /actions_result/i); }
    { const { sql, rep } = ins('STARTED', null, [{ status: 'OK' }]); await expectDbError(tx, sql, rep, /actions_result/i); }
    { const { sql, rep } = ins('STARTED', null, { action_key: 'a1', status: 'OK' }); await expectDbError(tx, sql, rep, /actions_result/i); }
    for (const s of ['PENDING', 'SCHEDULED', 'OK', 'SKIPPED', 'FAILED', 'UNKNOWN']) {
      const { sql, rep } = ins('STARTED', null, [{ action_key: 'k', status: s }]);
      await q(sql, rep, tx);
    }
    // Índice parcial da agenda.
    const [idx] = await q("SELECT indexdef FROM pg_indexes WHERE schemaname = 'marketing' AND tablename = 'automation_runs' AND indexdef ILIKE '%next_due_at%'");
    assert.match(idx.indexdef, /WAITING/);
  });
});

test('checks_de_rastreio_atribuicao_e_avaliacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [p] = await q('SELECT id FROM people.persons LIMIT 1', {}, tx);
    // tracking_links
    const tl = (over) => ({ ...base(tenantA), s: uid().slice(0, 10), u: 'https://exemplo.test/x', ch: 'SITE', sig: sha('s'), st: 'ACTIVE', ...over });
    const tlSql = `INSERT INTO marketing.tracking_links (group_id, company_id, short_code, target_url, channel, signature, status) VALUES (:g, :c, :s, :u, :ch, :sig, :st)`;
    const codigo = uid().slice(0, 10);
    await q(tlSql, tl({ s: codigo }), tx);
    await expectDbError(tx, tlSql, tl({ s: codigo }), /short_code/i);
    await expectDbError(tx, tlSql, tl({ st: 'X' }), /status/i);
    await expectDbError(tx, tlSql, tl({ u: 'javascript:alert(1)' }), /target_url|url/i);
    await expectDbError(tx, tlSql, tl({ ch: 'SMS' }), /channel/i);
    // short_code é único GLOBAL: outra empresa também não pode repetir (o erro vem do banco, mesmo sem ver a linha).
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    await expectDbError(tx, tlSql, tl({ ...base(tenantB), s: codigo }), /short_code/i);
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction: tx });

    // attribution_events
    const ae = (over) => ({ ...base(tenantA), et: 'CLICK', p: null, tr: '{}', ev: '{"k":1}', ...over });
    const aeSql = `INSERT INTO marketing.attribution_events (group_id, company_id, person_id, event_type, touch_roles, evidence_json, occurred_at)
      VALUES (:g, :c, :p, :et, CAST(:tr AS text[]), CAST(:ev AS jsonb), now())`;
    await q(aeSql, ae(), tx); // CLICK anônimo
    await q(aeSql, ae({ tr: '{FIRST,LAST}' }), tx);
    await expectDbError(tx, aeSql, ae({ et: 'SALE' }), /person/i);
    await expectDbError(tx, aeSql, ae({ et: 'LEAD_CREATED' }), /person/i);
    await expectDbError(tx, aeSql, ae({ et: 'ORDER' }), /event_type/i);
    await expectDbError(tx, aeSql, ae({ tr: '{MIDDLE}' }), /touch_roles/i);
    await expectDbError(tx, aeSql, ae({ ev: null }), /evidence_json/i);
    if (p) await q(aeSql, ae({ et: 'SALE', p: p.id, tr: '{LAST}' }), tx);

    // review_requests
    if (p) {
      const rr = (over) => ({ ...base(tenantA), p: p.id, s: uid(), st: 'PENDING', ch: 'EMAIL', sc: null, pr: null, ...over });
      const rrSql = `INSERT INTO marketing.review_requests (group_id, company_id, person_id, source_entity_type, source_entity_id, status, channel, satisfaction_score, public_rating)
        VALUES (:g, :c, :p, 'CONTRACT', :s, :st, :ch, :sc, :pr)`;
      await q(rrSql, rr({ sc: 5, pr: 1 }), tx);
      await expectDbError(tx, rrSql, rr({ sc: 0 }), /satisfaction/i);
      await expectDbError(tx, rrSql, rr({ sc: 6 }), /satisfaction/i);
      await expectDbError(tx, rrSql, rr({ pr: 6 }), /public_rating/i);
      await expectDbError(tx, rrSql, rr({ st: 'OPEN' }), /status/i);
      for (const st of ['PENDING', 'BLOCKED_NEGATIVE', 'SENT', 'DELIVERED', 'COMPLETED', 'FAILED', 'SUPPRESSED']) await q(rrSql, rr({ st }), tx);
    }
  });
});

test('publication_jobs_status_e_conexao_na_mesma_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { versionId } = await mkVersion(tenantA, tx);
    const sql = `INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at, attempts)
      VALUES (:g, :c, :v, :ch, 'a', :st, :k, now(), :n)`;
    const r = (o) => ({ ...base(tenantA), v: versionId, ch: 'SITE', st: 'PENDING', k: `pub:${versionId}:SITE:${uid()}`, n: 0, ...o });
    for (const st of ['PENDING', 'RUNNING', 'PUBLISHED', 'FAILED', 'UNKNOWN', 'CANCELLED']) await q(sql, r({ st }), tx);
    await expectDbError(tx, sql, r({ st: 'DONE' }), /status/i);
    await expectDbError(tx, sql, r({ ch: 'SMS' }), /channel/i);
    await expectDbError(tx, sql, r({ n: -1 }), /attempts/i);
    // Versão de outra empresa: a FK composta recusa.
    const outro = await sequelize.transaction(async (t2) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: t2 });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: t2 });
      return null;
    });
    assert.equal(outro, null);
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    await expectDbError(tx, sql, r({ ...base(tenantB) }), /content_version|foreign key/i);
  });
});

test('erros_da_parte_2_viram_codigos_mkt_em_portugues', async () => {
  const errorHandler = require('../src/middlewares/errorHandler');
  const chamar = (parent) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    errorHandler(Object.assign(new Error('x'), { name: 'SequelizeDatabaseError', parent }), { method: 'POST', originalUrl: '/x' }, res, () => {});
    return out;
  };
  const a = chamar({ code: 'MK002', message: 'MKT_RESULT_APPEND_ONLY' });
  assert.equal(a.status, 409);
  assert.equal(a.body.error.code, 'MKT_RESULT_APPEND_ONLY');
  assert.equal(a.body.error.message, 'O resultado de publicação não pode ser alterado.');
  const b = chamar({ code: 'MK003', message: 'MKT_AUTOMATION_VERSION_IMMUTABLE' });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'MKT_AUTOMATION_VERSION_IMMUTABLE');
  assert.equal(b.body.error.message, 'A versão publicada é imutável; crie uma nova versão.');
});

test('models_sequelize_da_parte_2_gravam_e_leem_sob_rls_e_replay_da_run', async () => {
  const models = require('../src/models');
  const { MarketingAutomationFlow, MarketingAutomationVersion, MarketingAutomationRun, MarketingSuppression, MarketingTrackingLink,
    MarketingAttributionEvent, MarketingPublicationJob, MarketingPublicationResult, MarketingReviewRequest } = models;
  for (const m of [MarketingAutomationFlow, MarketingAutomationVersion, MarketingAutomationRun, MarketingSuppression, MarketingTrackingLink,
    MarketingAttributionEvent, MarketingPublicationJob, MarketingPublicationResult, MarketingReviewRequest]) assert.ok(m, 'modelo ausente');
  const { createRunIdempotent } = require('../src/features/marketing/automationRuns.repository');
  await withRollbackTenantTransaction(tenantA, async (transaction) => {
    const b = { groupId: tenantA.groupId, companyId: tenantA.companyId };
    const flow = await MarketingAutomationFlow.create({ ...b, code: `F-${uid().slice(0, 6)}`, name: 'QA-M9', ownerUserId: tenantA.userId, riskLevel: 'LOW' }, { transaction });
    const ver = await MarketingAutomationVersion.create({ ...b, flowId: flow.id, versionNo: 1, triggerType: 'EVENT', actions: [], riskLevel: 'LOW', contentHash: sha('m') }, { transaction });
    const key = `run:${uid()}`;
    const dados = { ...b, automationVersionId: ver.id, correlationId: uid(), idempotencyKey: key, subjectType: 'PERSON', subjectId: uid() };
    const r1 = await createRunIdempotent(dados, { transaction });
    assert.equal(r1.replay, false);
    const r2 = await createRunIdempotent({ ...dados, correlationId: uid() }, { transaction });
    assert.equal(r2.replay, true);
    assert.equal(r2.code, 'MKT_RUN_REPLAY');
    assert.equal(r2.message, 'Esta execução já foi processada.');
    assert.equal(r2.run.id, r1.run.id);
    const n = await MarketingAutomationRun.count({ where: { idempotencyKey: key }, transaction });
    assert.equal(n, 1);
    await MarketingSuppression.create({ ...b, addressHash: sha('a@b.test'), channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, { transaction });
    await MarketingTrackingLink.create({ ...b, shortCode: uid().slice(0, 10), targetUrl: 'https://exemplo.test', channel: 'SITE', signature: sha('s') }, { transaction });
    await MarketingAttributionEvent.create({ ...b, eventType: 'CLICK', touchRoles: ['FIRST', 'LAST'], evidenceJson: { a: 1 }, occurredAt: new Date() }, { transaction });
  });
});

test('migration_da_parte_2_e_idempotente_e_reversivel', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
    t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
    return;
  }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const migration = require(path.resolve(__dirname, '../migrations/20260101000751-marketing-schema-parte-2.js'));
  const qi = admin.getQueryInterface();
  const contagem = async () => (await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'marketing' AND table_name IN (:t)", { replacements: { t: TABLES } }))[0][0].n;
  try {
    assert.equal(await contagem(), 9);
    await migration.up(qi);
    assert.equal(await contagem(), 9);
    await admin.query(`INSERT INTO marketing.suppression_list (group_id, company_id, address_hash, channel, reason, source, active)
      VALUES (:g, :c, :h, 'EMAIL', 'OPT_OUT', 'DOWN-TEST', true)`, { replacements: { ...base(tenantA), h: sha('down') } });
    await assert.rejects(() => migration.down(qi), /MKT_MIGRATION_DOWN_NOT_EMPTY|não está vazi/i);
    assert.equal(await contagem(), 9);
    await admin.query("DELETE FROM marketing.suppression_list WHERE source = 'DOWN-TEST'");
    await migration.down(qi);
    assert.equal(await contagem(), 0);
    await migration.up(qi);
    assert.equal(await contagem(), 9);
  } finally {
    await admin.close();
  }
});
