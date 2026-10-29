'use strict';

// M9-D015 — a chave inclui empresa e permissões efetivas; fonte revogada ou nova versão invalida; RLS da tabela e 404 entre empresas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { comoEmpresa } = require('../_helpers/ragSeed');
const { fonteIndexada, dados, entradaLookup, contar } = require('../_helpers/iaCache');
const cache = require('../../../src/features/ai/budgets/cache.service');
const { scopeKey, requestHash } = require('../../../src/features/ai/budgets/cache.key');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const ctxDe = (t) => ({ groupId: t.groupId, companyId: t.companyId, userId: t.userId });
const buscar = (d, tx, tenant = tenantA) => cache.lookup(entradaLookup(d), { tenant, transaction: tx });

test('m9d015_chave_inclui_permissoes_e_empresa', async () => {
  const pedido = requestHash({ taskType: 't', input: 'Qual o prazo?', purpose: 'p' });
  const base = { companyId: 'empresa-1', agentCode: 'NAY_X', agentVersion: 1, taskType: 't', permissions: ['b', 'a'], request: pedido };
  assert.equal(scopeKey(base), scopeKey({ ...base, permissions: ['a', 'b', 'a'] }), 'a ordem e a repetição das permissões não mudam a chave');
  assert.notEqual(scopeKey(base), scopeKey({ ...base, permissions: ['a'] }), 'menos permissão, outra chave');
  assert.notEqual(scopeKey(base), scopeKey({ ...base, companyId: 'empresa-2' }), 'outra empresa, outra chave');
  assert.notEqual(scopeKey(base), scopeKey({ ...base, agentVersion: 2 }));
  assert.equal(requestHash({ taskType: 'T', input: '  Qual   o PRAZO? ', purpose: 'P' }), pedido, 'pedido normalizado');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await definirParametro(tenantA, 'ia.cache.habilitado', true, tx);
    const d = dados([await fonteIndexada(tenantA, tx)]);
    assert.equal((await cache.store(ctxDe(tenantA), d, tx)).stored, true);
    assert.ok(await buscar(d, tx), 'mesma empresa e mesmas permissões acerta');
    assert.equal(await buscar({ ...d, permissions: ['ai:use'] }, tx), null, 'usuário com menos permissão nunca recebe a resposta');
    assert.equal(await buscar({ ...d, permissions: [...d.permissions, 'finance:read'] }, tx), null, 'nem com permissão a mais');
    assert.equal(await buscar({ ...d, agentVersion: 2 }, tx), null);
    assert.equal(await buscar({ ...d, input: 'Outra pergunta' }, tx), null);
  });
});

test('m9d015_outra_empresa_nao_acerta_e_recebe_404', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await definirParametro(tenantA, 'ia.cache.habilitado', true, tx);
    const d = dados([await fonteIndexada(tenantA, tx)]);
    const { key } = await cache.store(ctxDe(tenantA), d, tx);
    assert.equal((await cache.getByKey(ctxDe(tenantA), key, tx)).cached, true);
    await comoEmpresa(tenantB, tx, async () => {
      await definirParametro(tenantB, 'ia.cache.habilitado', true, tx);
      assert.equal(await cache.lookup(entradaLookup(d), { tenant: tenantB, transaction: tx }), null, 'a empresa B não acerta o cache da A');
      assert.equal(await contar(tx), 0, 'RLS: a B não enxerga linha da A');
      const err = await cache.getByKey(ctxDe(tenantB), key, tx).then(() => null, (e) => e);
      assert.ok(err, 'deveria recusar');
      assert.equal(err.code, 'AI_CACHE_NOT_FOUND');
      assert.equal(err.statusCode, 404);
      assert.equal(err.message, 'Resultado não encontrado.');
    });
  });
});

test('m9d015_fonte_revogada_invalida_entrada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await definirParametro(tenantA, 'ia.cache.habilitado', true, tx);
    const fonte = await fonteIndexada(tenantA, tx);
    const d = dados([fonte]);
    await cache.store(ctxDe(tenantA), d, tx);
    assert.ok(await buscar(d, tx), 'antes da revogação acerta');
    await q("UPDATE ai.chunks SET status = 'REVOKED' WHERE source_id = :id", { id: fonte.sourceRef }, tx);
    assert.equal(await buscar(d, tx), null, 'fonte revogada: não acerta');
    assert.equal(await contar(tx), 0, 'a entrada foi invalidada na hora');
    const trilha = await q("SELECT action FROM audit.audit_log WHERE entity_type = 'AiCacheEntry' ORDER BY created_at, id", {}, tx);
    assert.deepEqual(trilha.map((t) => t.action).sort(), ['AI_CACHE_INVALIDATE', 'AI_CACHE_STORE']);
  });
});

test('m9d015_fonte_com_nova_versao_invalida_entrada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await definirParametro(tenantA, 'ia.cache.habilitado', true, tx);
    const fonte = await fonteIndexada(tenantA, tx);
    const d = dados([fonte]);
    await cache.store(ctxDe(tenantA), d, tx);
    await q("UPDATE ai.chunks SET status = 'SUPERSEDED' WHERE source_id = :id", { id: fonte.sourceRef }, tx);
    assert.equal(await buscar(d, tx), null);
    assert.equal(await contar(tx), 0);
  });
});

test('m9d015_ai_cache_entries_tem_rls_force_e_isolamento', async () => {
  const [[t]] = await sequelize.query(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force, (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS politicas
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'cache_entries'`);
  assert.deepEqual([t.rls, t.force, t.politicas], [true, true, ['tenant_isolation']]);
});
