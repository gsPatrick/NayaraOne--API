'use strict';

// M9-D009 — duas conexões: corrigir a mesma memória ao mesmo tempo gera uma só versão nova (a segunda recebe 409), a mesma chave de
// idempotência grava uma só linha, e o job diário expira o que venceu. Commita dados: só roda no cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../../testHelpers');
const { runAiMemoryExpiryJob } = require('../../../src/engines/jobs/aiMemoryExpiryJob');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { memoria, comPerm, dados, origemRun } = require('../_helpers/iaMemoria');

const SKIP = process.env.DISPOSABLE_DB === '1' ? false : 'precisa do cluster descartável (nunca commitar no banco do .env)';
let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const ana = () => comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');

test('m9d009_correcao_concorrente_gera_uma_versao', { skip: SKIP }, async () => {
  const ctx = ana();
  const run = await withTenantTransaction(tenantA, (tx) => origemRun(tenantA, tx));
  const m = (await withTenantTransaction(tenantA, (tx) => memoria.save(ctx, dados(run, { subjectId: `conc-${uid()}` }), tx))).memory;
  const corrigir = (texto) => withTenantTransaction(tenantA, (tx) => memoria.correct(ctx, m.id, { value: { decision: texto } }, tx)).then((r) => r, (e) => e);
  const [a, b] = await Promise.all([corrigir('versão A'), corrigir('versão B')]);
  const ok = [a, b].filter((r) => r.memory);
  const falhas = [a, b].filter((r) => r.code);
  assert.equal(ok.length, 1, 'uma correção vence');
  assert.equal(falhas.length, 1);
  assert.equal(falhas[0].code, 'AI_MEMORY_NOT_ACTIVE'); assert.equal(falhas[0].statusCode, 409);
  const linhas = await withTenantTransaction(tenantA, (tx) => q('SELECT version, status FROM ai.memories WHERE id = :id OR supersedes_id = :id ORDER BY version', { id: m.id }, tx));
  assert.deepEqual(linhas.map((l) => [l.version, l.status]), [[1, 'SUPERSEDED'], [2, 'ACTIVE']]);
});

test('m9d009_mesma_chave_de_idempotencia_grava_uma_linha', { skip: SKIP }, async () => {
  const ctx = ana();
  const run = await withTenantTransaction(tenantA, (tx) => origemRun(tenantA, tx));
  const chave = `conc-${uid()}`;
  const gravar = () => withTenantTransaction(tenantA, (tx) => memoria.save(ctx, dados(run, { idempotencyKey: chave }), tx));
  const [a, b] = await Promise.all([gravar(), gravar()]);
  assert.equal(a.memory.id, b.memory.id);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  const [{ n }] = await withTenantTransaction(tenantA, (tx) => q('SELECT count(*)::int AS n FROM ai.memories WHERE idempotency_key = :k', { k: chave }, tx));
  assert.equal(n, 1);
});

test('m9d009_job_diario_expira_o_que_venceu', { skip: SKIP }, async () => {
  const ctx = ana();
  const run = await withTenantTransaction(tenantA, (tx) => origemRun(tenantA, tx));
  const passado = new Date('2026-01-10T12:00:00Z');
  const vencida = (await withTenantTransaction(tenantA, (tx) => memoria.save(ctx, dados(run, { subjectId: `job-${uid()}`, expiresAt: '2026-01-11T12:00:00Z' }), tx, { now: passado }))).memory;
  const vigente = (await withTenantTransaction(tenantA, (tx) => memoria.save(ctx, dados(run, { subjectId: `job-${uid()}` }), tx))).memory;
  const resumo = await runAiMemoryExpiryJob({ force: true });
  assert.equal(resumo.errors, 0);
  assert.ok(resumo.expired >= 1);
  const estados = await withTenantTransaction(tenantA, (tx) => q('SELECT id, status FROM ai.memories WHERE id IN (:a, :b)', { a: vencida.id, b: vigente.id }, tx));
  const por = Object.fromEntries(estados.map((e) => [e.id, e.status]));
  assert.equal(por[vencida.id], 'EXPIRED');
  assert.equal(por[vigente.id], 'ACTIVE');
  assert.equal((await runAiMemoryExpiryJob({ force: true })).expired, 0, 'repetir não muda nada');
  // Dentro do intervalo configurado a empresa não é processada de novo.
  assert.equal((await runAiMemoryExpiryJob()).companies, 0);
});
