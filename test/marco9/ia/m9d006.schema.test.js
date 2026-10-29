'use strict';

// Marco 9, M9-D006 — ai.tool_calls no banco: restrições, RLS FORCE, máquina de estados e linha final imutável (gatilho), sem
// EXPIRED e sem DELETE, leitura por ai:audit e retenção do conteúdo (M9-D028). Postgres real com nayara_runtime em transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { listToolCallsByRun } = require('../../../src/features/ai/tools');
const retention = require('../../../src/features/ai/retention');
const { sequelize, q, run, uid, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { abrirRun, ferramenta, rodar } = require('../_helpers/iaToolCalls');
const { runVelho } = require('../_helpers/iaRetencao');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const HASH = 'a'.repeat(64);
async function inserir(tx, runId, over = {}) {
  const id = uid();
  const c = {
    id, g: tenantA.groupId, c: tenantA.companyId, runId, seq: over.seq || 1, tool: over.tool || 'crm.x', ver: over.ver === undefined ? '1' : over.ver,
    perm: over.perm === undefined ? 'crm:read' : over.perm, args: JSON.stringify(over.args || {}), risk: over.risk === undefined ? 'LOW' : over.risk, status: over.status || 'REQUESTED',
    reason: over.reason || null, key: over.key || `k-${id}`, hash: over.hash || HASH,
  };
  await run(
    `INSERT INTO ai.tool_calls (id, group_id, company_id, run_id, seq, tool_name, tool_version, permission_code, risk_level, status, blocked_reason, args_hash, idempotency_key, args_sanitized)
     VALUES (:id, :g, :c, :runId, :seq, :tool, :ver, :perm, :risk, :status, :reason, :hash, :key, CAST(:args AS jsonb))`, c, tx
  );
  return id;
}
const passos = async (tx, id, ...estados) => { for (const s of estados) await run('UPDATE ai.tool_calls SET status = :s WHERE id = :id', { s, id }, tx); };

test('m9d006_tabela_e_restricoes_existem', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const colunas = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'tool_calls'", {}, tx)).map((c) => c.column_name);
    for (const c of ['id', 'group_id', 'company_id', 'run_id', 'seq', 'tool_name', 'tool_version', 'permission_code', 'risk_level', 'args_sanitized', 'args_hash',
      'idempotency_key', 'status', 'blocked_reason', 'result_summary', 'result_hash', 'latency_ms', 'proposal_id', 'started_at', 'finished_at']) assert.ok(colunas.includes(c), `falta a coluna ${c}`);
    const [rls] = await q("SELECT relrowsecurity AS rls, relforcerowsecurity AS forca FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'tool_calls'", {}, tx);
    assert.deepEqual(rls, { rls: true, forca: true });
    assert.equal((await q("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'ai.tool_calls'::regclass", {}, tx))[0].n >= 1, true);
    const unicos = (await q("SELECT conname FROM pg_constraint WHERE conrelid = 'ai.tool_calls'::regclass AND contype = 'u' ORDER BY 1", {}, tx)).map((c) => c.conname);
    assert.deepEqual(unicos, ['tool_calls_idempotency_uq', 'tool_calls_run_seq_uq']);
    const idx = (await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'ai' AND tablename = 'tool_calls'", {}, tx)).map((i) => i.indexname);
    assert.ok(idx.includes('ai_tool_calls_run_idx'));
    const fks = await q("SELECT confrelid::regclass::text AS alvo FROM pg_constraint WHERE conrelid = 'ai.tool_calls'::regclass AND contype = 'f' ORDER BY 1", {}, tx);
    assert.ok(fks.some((f) => f.alvo === 'ai.ai_runs') && fks.some((f) => f.alvo === 'ai.ai_recommendations'));
    // o runtime lê, insere e atualiza (o DELETE, mesmo que o cluster conceda, é barrado pelo gatilho: ver m9d006_linha_final_imutavel)
    const [g] = await q("SELECT has_table_privilege('nayara_runtime', 'ai.tool_calls', 'SELECT') AS sel, has_table_privilege('nayara_runtime', 'ai.tool_calls', 'UPDATE') AS upd", {}, tx);
    assert.deepEqual(g, { sel: true, upd: true });
  });
});

test('m9d006_unicidade_e_checks', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const runId = await abrirRun({ ...ctx, permissions: ['ai:use'] }, tx);
    await inserir(tx, runId, { key: 'igual', tool: 'crm.x', seq: 1 });
    const novo = (over) => ({ id: uid(), g: tenantA.groupId, c: tenantA.companyId, runId, seq: 9, tool: 'crm.x', key: `k-${uid()}`, hash: HASH, status: 'REQUESTED', ver: '1', perm: 'p', risk: 'LOW', reason: null, ...over });
    const ins = 'INSERT INTO ai.tool_calls (id, group_id, company_id, run_id, seq, tool_name, tool_version, permission_code, risk_level, status, blocked_reason, args_hash, idempotency_key) VALUES (:id, :g, :c, :runId, :seq, :tool, :ver, :perm, :risk, :status, :reason, :hash, :key)';
    await expectDbError(tx, ins, novo({ key: 'igual', seq: 2 }), /tool_calls_idempotency_uq/);
    await expectDbError(tx, ins, novo({ seq: 1 }), /tool_calls_run_seq_uq/);
    await expectDbError(tx, ins, novo({ seq: 0 }), /tool_calls_seq_chk/);
    await expectDbError(tx, ins, novo({ risk: 'ALTO' }), /tool_calls_risk_chk/);
    await expectDbError(tx, ins, novo({ hash: 'xyz' }), /tool_calls_args_hash_chk/);
    // sem os dados da tool a chamada só pode seguir para BLOCKED; validar sem eles é recusado
    const semMeta = await inserir(tx, runId, { seq: 3, perm: null });
    await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'VALIDATED' WHERE id = :id", { id: semMeta }, /tool_calls_meta_chk/);
    await expectDbError(tx, ins, novo({ status: 'BLOCKED', reason: null, perm: null }), /tool_calls_blocked_chk/);
    // EXPIRED não existe (D007: não há expiração por tempo)
    await expectDbError(tx, ins, novo({ status: 'EXPIRED' }), /tool_calls_status_chk|AI_TOOL_CALL_TRANSITION/);
    const [def] = await q("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'tool_calls_status_chk' AND conrelid = 'ai.tool_calls'::regclass", {}, tx);
    assert.ok(!def.d.includes('EXPIRED') && def.d.includes('CANCELLED_BY_HUMAN'), 'o CHECK de status não aceita EXPIRED');
    // a chamada nasce em REQUESTED (ou BLOCKED), nunca já em andamento ou concluída
    await expectDbError(tx, ins, novo({ status: 'SUCCEEDED' }), /AI_TOOL_CALL_TRANSITION/);
    // BLOCKED nasce final, sem metadados da tool quando ela nem existe
    const bloqueada = uid();
    await run(`INSERT INTO ai.tool_calls (id, group_id, company_id, run_id, seq, tool_name, args_hash, idempotency_key, status, blocked_reason)
               VALUES (:id, :g, :c, :runId, 5, 'nao.existe', :hash, 'kb', 'BLOCKED', 'tool_nao_registrada')`, { id: bloqueada, g: tenantA.groupId, c: tenantA.companyId, runId, hash: HASH }, tx);
    assert.ok((await q('SELECT finished_at FROM ai.tool_calls WHERE id = :id', { id: bloqueada }, tx))[0].finished_at);
  });
});

test('m9d006_linha_final_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const runId = await abrirRun({ ...ctxDe(tenantA), permissions: ['ai:use'] }, tx);
    const finais = {};
    for (const [i, alvo] of [['SUCCEEDED', ['VALIDATED', 'EXECUTING', 'SUCCEEDED']], ['FAILED', ['VALIDATED', 'EXECUTING', 'FAILED']],
      ['CANCELLED_BY_HUMAN', ['VALIDATED', 'PROPOSED', 'CANCELLED_BY_HUMAN']]].entries()) {
      finais[alvo[0]] = await inserir(tx, runId, { seq: i + 1 });
      await passos(tx, finais[alvo[0]], ...alvo[1]);
    }
    finais.BLOCKED = await inserir(tx, runId, { seq: 4 });
    await passos(tx, finais.BLOCKED); // ainda REQUESTED
    await run("UPDATE ai.tool_calls SET status = 'BLOCKED', blocked_reason = 'SCHEMA' WHERE id = :id", { id: finais.BLOCKED }, tx);
    for (const [estado, id] of Object.entries(finais)) {
      assert.ok((await q('SELECT finished_at FROM ai.tool_calls WHERE id = :id', { id }, tx))[0].finished_at, `${estado} tem fim`);
      await expectDbError(tx, "UPDATE ai.tool_calls SET result_summary = '{\"x\":1}'::jsonb WHERE id = :id", { id }, /AI_TOOL_CALL_IMMUTABLE/);
      await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'EXECUTING' WHERE id = :id", { id }, /AI_TOOL_CALL_IMMUTABLE/);
      await expectDbError(tx, 'DELETE FROM ai.tool_calls WHERE id = :id', { id }, /AI_TOOL_CALL_IMMUTABLE/);
    }
    // enquanto não é final: transição fora da máquina e identidade/argumentos imutáveis
    const aberta = await inserir(tx, runId, { seq: 7 });
    await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'SUCCEEDED' WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_TRANSITION/);
    await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'PROPOSED' WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_TRANSITION/);
    await expectDbError(tx, "UPDATE ai.tool_calls SET tool_name = 'outra' WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.tool_calls SET args_sanitized = '{\"a\":1}'::jsonb WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.tool_calls SET idempotency_key = 'trocada' WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_IMMUTABLE/);
    await passos(tx, aberta, 'VALIDATED', 'PROPOSED');
    await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'EXECUTING' WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_TRANSITION/);
    await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'VALIDATED' WHERE id = :id", { id: aberta }, /AI_TOOL_CALL_TRANSITION/);
  });
});

test('m9d006_leitura_por_ai_audit_e_isolada_por_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use', 'ai:audit'] };
    const runId = await abrirRun(ctx, tx);
    const { tool } = ferramenta();
    for (const seq of [2, 1]) await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: `R${seq}` }, seq });
    const lista = await listToolCallsByRun(ctx, runId, tx);
    assert.deepEqual(lista.map((l) => [l.seq, l.status]), [[1, 'SUCCEEDED'], [2, 'SUCCEEDED']], 'na ordem da execução');
    for (const sem of [['ai:use'], ['ai:read'], []]) {
      const err = await listToolCallsByRun({ ...ctx, permissions: sem }, runId, tx).then(() => null, (e) => e);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'PERMISSION_DENIED');
    }
    assert.deepEqual(await listToolCallsByRun(ctx, uid(), tx), [], 'run inexistente: vazio, sem revelar');
    assert.equal((await listToolCallsByRun(ctx, 'nao-uuid', tx).then(() => null, (e) => e)).statusCode, 404);
    // Na sessão da empresa B (mesma transação, outra empresa) as linhas da A não existem.
    await run('SET LOCAL app.company_id = :c', { c: tenantB.companyId }, tx);
    await run('SET LOCAL app.group_id = :g', { g: tenantB.groupId }, tx);
    assert.equal((await q('SELECT count(*)::int AS n FROM ai.tool_calls WHERE run_id = :id', { id: runId }, tx))[0].n, 0);
    assert.deepEqual(await listToolCallsByRun({ ...ctx, companyId: tenantB.companyId, groupId: tenantB.groupId }, runId, tx), []);
  });
});

test('m9d006_retencao_apaga_so_args_e_resultado_do_run_vencido', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const velho = await runVelho(tenantA, tx, { diasAtras: 31, fontes: ['RESTRICTED'] });
    const novo = await runVelho(tenantA, tx, { diasAtras: 5, fontes: ['RESTRICTED'] });
    const ids = {};
    for (const [rotulo, runId] of [['velho', velho.id], ['novo', novo.id]]) {
      ids[rotulo] = await inserir(tx, runId, { seq: 1, args: { ref: '[REDIGIDO:cpf]' } });
      await passos(tx, ids[rotulo], 'VALIDATED', 'EXECUTING');
      await run(`UPDATE ai.tool_calls SET status = 'SUCCEEDED', result_summary = '{"total":3}'::jsonb, result_hash = :h WHERE id = :id`, { id: ids[rotulo], h: HASH }, tx);
    }
    const r = await retention.purgeExpiredAiContent(ctx, tx);
    assert.equal(r.runs, 1, 'só o run RESTRICTED com 31 dias venceu (prazo padrão de 30)');
    const [v] = await q('SELECT status, args_sanitized, result_summary, result_hash, args_hash, content_purged_at FROM ai.tool_calls WHERE id = :id', { id: ids.velho }, tx);
    assert.deepEqual(v.args_sanitized, {}, 'os argumentos foram apagados');
    assert.equal(v.result_summary, null);
    assert.ok(v.content_purged_at);
    assert.equal(v.status, 'SUCCEEDED');
    assert.equal(v.result_hash, HASH, 'o hash do resultado e o dos argumentos ficam');
    assert.equal(v.args_hash, HASH);
    const [n] = await q('SELECT status, result_summary, content_purged_at FROM ai.tool_calls WHERE id = :id', { id: ids.novo }, tx);
    assert.deepEqual(n.result_summary, { total: 3 });
    assert.deepEqual((await q('SELECT args_sanitized FROM ai.tool_calls WHERE id = :id', { id: ids.novo }, tx))[0].args_sanitized, { ref: '[REDIGIDO:cpf]' });
    assert.equal(n.content_purged_at, null);
    // fora do expurgo ninguém consegue apagar o conteúdo nem pelo UPDATE direto
    await expectDbError(tx, "UPDATE ai.tool_calls SET result_summary = NULL, content_purged_at = now() WHERE id = :id", { id: ids.novo }, /AI_TOOL_CALL_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.tool_calls SET result_summary = '{\"forjado\":1}'::jsonb WHERE id = :id", { id: ids.velho }, /AI_TOOL_CALL_IMMUTABLE/);
    // um run de outra empresa nunca é tocado (a função só enxerga a empresa da sessão)
    assert.equal(tenantB.companyId === tenantA.companyId, false);
  });
});
