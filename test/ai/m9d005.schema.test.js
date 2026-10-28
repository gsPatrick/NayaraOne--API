'use strict';

// M9-D005 — ai.ai_runs e ai.ai_sources no banco: colunas, CHECKs, máquina de estados, imutabilidade em estado final,
// idempotência, custo em seis casas e compatibilidade com os runs legados. Rodar em banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../testHelpers');
const { sequelize, uid, q, run, prepararTenants, expectDbError, inserirRun, lerRun } = require('../helpers/aiRuns');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const COLUNAS_RUN = ['agent_id', 'agent_version', 'purpose', 'provider_code', 'model_code', 'routing_path', 'tokens_in', 'tokens_out',
  'cost_currency', 'latency_ms', 'grounding_status', 'confidence', 'blocked_reason', 'error_code', 'idempotency_key', 'parent_run_id',
  'started_at', 'finished_at', 'snapshot_at', 'request_hash', 'fallback_trail', 'escalated', 'cached'];
const COLUNAS_FONTE = ['source_version', 'classification', 'effective_from', 'effective_until', 'retrieved_at', 'relevance_score',
  'used_in_answer', 'status_at_retrieval', 'content_hash'];

test('m9d005_migrations_criam_colunas_checks_gatilho_e_mantem_rls_force', async () => {
  for (const [tabela, colunas] of [['ai_runs', COLUNAS_RUN], ['ai_sources', COLUNAS_FONTE]]) {
    const achadas = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = :t", { t: tabela })).map((r) => r.column_name);
    for (const c of colunas) assert.ok(achadas.includes(c), `ai.${tabela}.${c} não existe`);
    const [r] = await q(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege('nayara_runtime', c.oid, 'INSERT') AS ins,
              has_table_privilege('nayara_runtime', c.oid, 'UPDATE') AS upd
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = :t`, { t: tabela }
    );
    assert.equal(r.relrowsecurity, true); assert.equal(r.relforcerowsecurity, true); assert.ok(r.ins && r.upd);
  }
  const [{ n }] = await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'ai.ai_runs'::regclass AND NOT tgisinternal");
  assert.ok(n >= 1, 'gatilho de imutabilidade do run');
  const [custo] = await q("SELECT numeric_precision AS p, numeric_scale AS s FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'ai_runs' AND column_name = 'cost_amount'");
  assert.deepEqual([Number(custo.p), Number(custo.s)], [18, 6]);
});

test('m9d005_run_final_e_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    for (const final of ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED']) {
      const id = await inserirRun(tenantA, tx);
      if (final === 'CANCELLED') await run("UPDATE ai.ai_runs SET status = 'AWAITING_APPROVAL' WHERE id = :id", { id }, tx);
      const extra = final === 'BLOCKED' ? ", blocked_reason = 'POLICY'" : '';
      await run(`UPDATE ai.ai_runs SET status = '${final}'${extra}, finished_at = now() WHERE id = :id`, { id }, tx);
      await expectDbError(tx, "UPDATE ai.ai_runs SET output_summary = 'mudou' WHERE id = :id", { id }, /AI_RUN_IMMUTABLE/);
      await expectDbError(tx, "UPDATE ai.ai_runs SET input_summary = 'mudou' WHERE id = :id", { id }, /AI_RUN_IMMUTABLE/);
      await expectDbError(tx, "UPDATE ai.ai_runs SET status = 'RUNNING' WHERE id = :id", { id }, /AI_RUN_IMMUTABLE/);
      await expectDbError(tx, 'DELETE FROM ai.ai_runs WHERE id = :id', { id }, /AI_RUN_IMMUTABLE/);
    }
    const emAndamento = await inserirRun(tenantA, tx);
    await run("UPDATE ai.ai_runs SET input_summary = 'ok', output_summary = 'parcial' WHERE id = :id", { id: emAndamento }, tx);
    await expectDbError(tx, 'DELETE FROM ai.ai_runs WHERE id = :id', { id: emAndamento }, /AI_RUN_IMMUTABLE/);
  });
});

test('m9d005_transicoes_validas_e_invalidas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const validas = [['RUNNING', 'COMPLETED'], ['RUNNING', 'FAILED'], ['RUNNING', 'AWAITING_APPROVAL'], ['AWAITING_APPROVAL', 'COMPLETED'], ['AWAITING_APPROVAL', 'CANCELLED']];
    for (const [de, para] of validas) {
      const id = await inserirRun(tenantA, tx);
      if (de !== 'RUNNING') await run(`UPDATE ai.ai_runs SET status = '${de}' WHERE id = :id`, { id }, tx);
      await run(`UPDATE ai.ai_runs SET status = '${para}', finished_at = now() WHERE id = :id`, { id }, tx);
      assert.equal((await lerRun(id, tx)).status, para);
    }
    const bloqueado = await inserirRun(tenantA, tx);
    await run("UPDATE ai.ai_runs SET status = 'BLOCKED', blocked_reason = 'POLICY', finished_at = now() WHERE id = :id", { id: bloqueado }, tx);
    const invalidas = [['RUNNING', 'CANCELLED'], ['AWAITING_APPROVAL', 'FAILED'], ['AWAITING_APPROVAL', 'BLOCKED'], ['AWAITING_APPROVAL', 'RUNNING']];
    for (const [de, para] of invalidas) {
      const id = await inserirRun(tenantA, tx);
      if (de !== 'RUNNING') await run(`UPDATE ai.ai_runs SET status = '${de}' WHERE id = :id`, { id }, tx);
      await expectDbError(tx, `UPDATE ai.ai_runs SET status = '${para}', finished_at = now(), blocked_reason = 'X' WHERE id = :id`, { id }, /AI_RUN_TRANSITION/);
    }
    await expectDbError(tx, "UPDATE ai.ai_runs SET status = 'QUALQUER' WHERE id = :id", { id: await inserirRun(tenantA, tx) }, /ai_runs_status_chk/);
    // finished_at é preenchido ao entrar em estado final.
    const id = await inserirRun(tenantA, tx);
    await run("UPDATE ai.ai_runs SET status = 'COMPLETED' WHERE id = :id", { id }, tx);
    assert.ok((await lerRun(id, tx)).finished_at, 'finished_at obrigatório em estado final');
    // BLOCKED sem motivo é recusado.
    await expectDbError(tx, "UPDATE ai.ai_runs SET status = 'BLOCKED' WHERE id = :id", { id: await inserirRun(tenantA, tx) }, /ai_runs_blocked_reason_chk/);
  });
});

test('m9d005_colunas_fallback_trail_escalated_e_cached_gravadas_e_imutaveis', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const id = await inserirRun(tenantA, tx);
    const padrao = await lerRun(id, tx);
    assert.deepEqual(padrao.fallback_trail, []); assert.equal(padrao.escalated, false); assert.equal(padrao.cached, false);
    assert.equal(padrao.routing_path, 'RULE');
    await run(
      `UPDATE ai.ai_runs SET fallback_trail = '[{"from":"sandbox-a","to":"sandbox-b","reason":"TIMEOUT"}]'::jsonb, escalated = true, routing_path = 'ADVANCED_MODEL' WHERE id = :id`, { id }, tx
    );
    const gravado = await lerRun(id, tx);
    assert.equal(gravado.fallback_trail[0].reason, 'TIMEOUT'); assert.equal(gravado.escalated, true);
    const cache = await inserirRun(tenantA, tx);
    await run("UPDATE ai.ai_runs SET cached = true, routing_path = 'CACHE' WHERE id = :id", { id: cache }, tx);
    await expectDbError(tx, "UPDATE ai.ai_runs SET cached = true, routing_path = 'RULE' WHERE id = :id", { id: await inserirRun(tenantA, tx) }, /ai_runs_cached_chk/);
    await expectDbError(tx, "UPDATE ai.ai_runs SET fallback_trail = '{}'::jsonb WHERE id = :id", { id: await inserirRun(tenantA, tx) }, /ai_runs_fallback_trail_chk/);
    await run("UPDATE ai.ai_runs SET status = 'COMPLETED', finished_at = now() WHERE id = :id", { id }, tx);
    for (const set of ["fallback_trail = '[]'::jsonb", 'escalated = false', 'cached = true', "routing_path = 'RULE'"]) {
      await expectDbError(tx, `UPDATE ai.ai_runs SET ${set} WHERE id = :id`, { id }, /AI_RUN_IMMUTABLE/);
    }
  });
});

test('m9d005_runs_legados_continuam_validos', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Exatamente o INSERT que as cinco NAYs determinísticas fazem hoje (sem nenhuma coluna nova).
    const id = uid();
    await run(
      `INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, input_summary, tool_calls_json, output_summary, status, cost_amount, created_at, updated_at)
       VALUES (:id, :g, :c, 'NAY_FINANCEIRA', 'entrada', '{"method":"RULE_BASED"}'::jsonb, 'saida', 'COMPLETED', NULL, now(), now())`,
      { id, g: tenantA.groupId, c: tenantA.companyId }, tx
    );
    const r = await lerRun(id, tx);
    assert.equal(r.status, 'COMPLETED'); assert.equal(r.routing_path, 'RULE'); assert.equal(r.grounding_status, 'NOT_APPLICABLE');
    assert.ok(r.finished_at, 'finished_at preenchido no insert de run já final'); assert.equal(r.tokens_in, 0); assert.equal(r.cost_currency, 'BRL');
    await expectDbError(tx, "UPDATE ai.ai_runs SET output_summary = 'x' WHERE id = :id", { id }, /AI_RUN_IMMUTABLE/);
  });
});

test('m9d005_idempotency_key_unica_por_empresa_no_banco', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const chave = `k-${uid()}`;
    await inserirRun(tenantA, tx, { idempotencyKey: chave });
    await expectDbError(tx, 'INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, idempotency_key) VALUES (:id, :g, :c, :a, :k)',
      { id: uid(), g: tenantA.groupId, c: tenantA.companyId, a: 'X', k: chave }, /ai_runs_idempotency_uq/);
    await inserirRun(tenantA, tx); await inserirRun(tenantA, tx); // sem chave, quantas quiser
  });
});

test('m9d005_custo_numeric_18_6_soma_exata_no_banco', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const marca = uid();
    for (const custo of ['0.100000', '0.200000', '0.012345']) {
      await run("INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, cost_amount, input_summary) VALUES (:id, :g, :c, 'X', :v, :m)",
        { id: uid(), g: tenantA.groupId, c: tenantA.companyId, v: custo, m: marca }, tx);
    }
    const [soma] = await q('SELECT SUM(cost_amount)::text AS s FROM ai.ai_runs WHERE input_summary = :m', { m: marca }, tx);
    assert.equal(soma.s, '0.312345');
    await expectDbError(tx, "INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, cost_amount) VALUES (:id, :g, :c, 'X', -1)",
      { id: uid(), g: tenantA.groupId, c: tenantA.companyId }, /ai_runs_cost_chk/);
  });
});

test('m9d005_fonte_no_banco_tipos_limite_e_imutavel_em_run_final', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const runId = await inserirRun(tenantA, tx);
    const base = { g: tenantA.groupId, c: tenantA.companyId, r: runId };
    const params = (over = {}) => ({ ...base, id: uid(), tipo: 'READ_MODEL', ex: 'trecho', cls: 'INTERNAL', st: 'VIGENTE', ...over });
    const sql = `INSERT INTO ai.ai_sources (id, group_id, company_id, ai_run_id, source_type, excerpt, classification, status_at_retrieval)
                 VALUES (:id, :g, :c, :r, :tipo, :ex, :cls, :st)`;
    for (const tipo of ['READ_MODEL', 'DOCUMENT_CHUNK', 'KNOWLEDGE_ENTRY', 'MEMORY', 'TOOL_RESULT']) await run(sql, params({ tipo }), tx);
    await expectDbError(tx, sql, params({ tipo: 'DOCUMENTO_QUALQUER' }), /ai_sources_type_chk/);
    await expectDbError(tx, sql, params({ cls: 'SECRETO' }), /ai_sources_classification_chk/);
    await expectDbError(tx, sql, params({ st: 'TALVEZ' }), /ai_sources_status_chk/);
    await expectDbError(tx, sql, params({ ex: 'a'.repeat(2001) }), /ai_sources_excerpt_chk/);
    const fonte = uid();
    await run(sql, params({ id: fonte }), tx);
    await run("UPDATE ai.ai_runs SET status = 'COMPLETED', finished_at = now() WHERE id = :id", { id: runId }, tx);
    await expectDbError(tx, "UPDATE ai.ai_sources SET excerpt = 'outro' WHERE id = :id", { id: fonte }, /AI_RUN_IMMUTABLE/);
    await expectDbError(tx, 'DELETE FROM ai.ai_sources WHERE id = :id', { id: fonte }, /AI_RUN_IMMUTABLE/);
    await expectDbError(tx, sql, params(), /AI_RUN_IMMUTABLE/);
  });
});
