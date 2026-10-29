'use strict';

// M9-D017 — a NAY age em nome de alguém: permissão efetiva é a interseção, a conexão nunca é superusuário e a identidade de
// serviço (jobs) é só leitura. Banco descartável, role nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { carregarPessoas, ctxDe, q, run } = require('../../helpers/aiAgents');
const { initToolRegistry, ToolRegistry } = require('../../../src/features/ai/tools');
const { runToolCall } = require('../../../src/features/ai/orchestrator/toolCallPipeline');
const { buildUserContext, loadServiceContext, serviceLabel, effectivePermissions } = require('../../../src/features/ai/orchestrator/executionContext');
const { assertRuntimeIdentity, assertRuntimeConnection } = require('../../../src/features/ai/orchestrator/runtimeConnection');
const identities = require('../../../src/features/ai/serviceIdentities');
const { sequelize, agenteCom, contextoDe, gravador, LIMITES } = require('../_helpers/aiToolsEnv');
const { defValida, PERMISSION_CODES, ID } = require('../_helpers/aiToolDefs');

let tenantA; let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const admin = (tenant) => ({ ...ctxDe(tenant), permissions: ['ai:admin'] });
const rejeita = async (promessa, status, code) => {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
};

test('m9d017_permissao_efetiva_e_interseccao', async () => {
  const registry = await initToolRegistry();
  const agente = agenteCom('crm.getOpportunity', 'crm.getCustomerSummary');
  // Usuário tem crm e finance; o agente só declara crm e people: a efetiva é só o que está nos DOIS lados.
  const ctx = contextoDe(tenantA, ['crm:opportunities:read', 'finance:read', 'qualquer:coisa']);
  assert.deepEqual(effectivePermissions(ctx, agente, registry).sort(), ['crm:opportunities:read']);
  // A NAY nunca recebe permissão que o usuário não tem: people:read está nas tools do agente, mas não no usuário.
  assert.ok(!effectivePermissions(ctx, agente, registry).includes('people:read'));
  // E o usuário não ganha permissão por pedir via NAY: finance:read não está em nenhuma tool do agente.
  assert.ok(!effectivePermissions(ctx, agente, registry).includes('finance:read'));
  // Tool desabilitada ou desconhecida na allowlist não contribui com permissão.
  const desab = { code: 'X', tools: [{ toolName: 'crm.getOpportunity', enabled: false }, { toolName: 'nao.existe', enabled: true }] };
  assert.deepEqual(effectivePermissions(ctx, desab, registry), []);

  // A tool recebe exatamente a efetiva em ctx.auth.permissions (e o contexto fica congelado).
  let visto;
  const reg = new ToolRegistry({ permissionCodes: PERMISSION_CODES });
  reg.register(defValida({ name: 'teste.espia', permissionCode: 'crm:opportunities:read', execute: async (c) => { visto = [...c.auth.permissions]; return { id: 'x' }; } }));
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await runToolCall({ execCtx: ctx, agent: agenteCom('teste.espia'), registry: reg, toolName: 'teste.espia', args: { id: ID }, transaction: tx, recorder: gravador(), argsLimits: LIMITES });
  });
  assert.deepEqual(visto, ['crm:opportunities:read']);
});

test('m9d017_conexao_nao_e_superuser', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const id = await assertRuntimeConnection(tx);
    assert.equal(id.rolsuper, false);
    assert.equal(id.rolbypassrls, false);
    assert.equal(id.currentUser, 'nayara_runtime');
    // O mesmo role que a tool enxerga (a pipeline confere antes de cada chamada).
    const [{ u, s }] = await q('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s', {}, tx);
    assert.equal(u, id.currentUser);
    assert.equal(s, false);
  });
  // Superusuário, dono ou bypass de RLS: a conexão é recusada (500), nunca usada.
  for (const ruim of [{ currentUser: 'postgres', rolsuper: true, rolbypassrls: true }, { currentUser: 'x', rolsuper: false, rolbypassrls: true }, { currentUser: 'x', rolsuper: true, rolbypassrls: false }]) {
    assert.throws(() => assertRuntimeIdentity(ruim), (e) => e.statusCode === 500 && e.code === 'AI_CONNECTION_NOT_ALLOWED');
  }
  assert.doesNotThrow(() => assertRuntimeIdentity({ currentUser: 'nayara_runtime', rolsuper: false, rolbypassrls: false }));
});

test('m9d017_service_identity_so_leitura', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = admin(tenantA);
    const criada = await identities.createServiceIdentity(ctx, { agentCode: 'NAY_FINANCEIRA', permissions: ['finance:read', 'crm:opportunities:read:own'] }, tx);
    assert.equal(criada.agentCode, 'NAY_FINANCEIRA');
    assert.equal(criada.enabled, true);
    assert.deepEqual([...criada.permissions].sort(), ['crm:opportunities:read:own', 'finance:read']);

    // Escrita, aprovação, administração e curinga são recusadas (400), uma a uma.
    for (const ruim of ['finance:create', 'crm:opportunities:update', 'finance:approve', 'ai:admin', 'legal:delete', '*', 'finance:*', 'crm:opportunities:export']) {
      const err = await rejeita(identities.createServiceIdentity(ctx, { agentCode: 'NAY_JURIDICA', permissions: ['finance:read', ruim] }, tx), 400, 'AI_SERVICE_IDENTITY_INVALID');
      assert.equal(err.message, 'A identidade de serviço só pode ter permissões de leitura.', ruim);
    }
    // Permissão que não existe no catálogo também é recusada.
    await rejeita(identities.createServiceIdentity(ctx, { agentCode: 'NAY_JURIDICA', permissions: ['inventado:read'] }, tx), 400, 'AI_SERVICE_IDENTITY_INVALID');
    // Sem ai:admin não cria nem altera.
    await rejeita(identities.createServiceIdentity({ ...ctx, permissions: ['ai:use'] }, { agentCode: 'NAY_JURIDICA', permissions: ['legal:read'] }, tx), 403, 'PERMISSION_DENIED');
    // Alterar também valida: não dá para promover a identidade a escrita depois.
    await rejeita(identities.updateServiceIdentity(ctx, criada.id, { permissions: ['finance:read', 'finance:settle'] }, tx), 400, 'AI_SERVICE_IDENTITY_INVALID');
    const alterada = await identities.updateServiceIdentity(ctx, criada.id, { permissions: ['finance:read'] }, tx);
    assert.deepEqual(alterada.permissions, ['finance:read']);
    // Uma por empresa e agente.
    await rejeita(identities.createServiceIdentity(ctx, { agentCode: 'NAY_FINANCEIRA', permissions: ['finance:read'] }, tx), 409, 'AI_SERVICE_IDENTITY_EXISTS');

    // O banco também recusa escrita (a CHECK não depende do serviço).
    await run('SAVEPOINT s1', {}, tx);
    const bruto = await run(
      `INSERT INTO ai.service_identities (group_id, company_id, agent_code, permissions) VALUES (:g, :c, 'NAY_BANCO', '["finance:create"]'::jsonb)`,
      { g: tenantA.groupId, c: tenantA.companyId }, tx
    ).then(() => null, (e) => e);
    assert.ok(bruto && /service_identities_read_only_chk/.test(String(bruto.message)), 'a CHECK do banco recusa permissão de escrita');
    await run('ROLLBACK TO SAVEPOINT s1', {}, tx);

    // Contexto do job: ator SERVICE, só as permissões da identidade, nome nos logs com a empresa.
    const job = await loadServiceContext({ groupId: tenantA.groupId, companyId: tenantA.companyId }, 'NAY_FINANCEIRA', tx, { correlationId: 'job-1' });
    assert.deepEqual(job.actor, { type: 'SERVICE', serviceIdentityId: criada.id });
    assert.deepEqual([...job.permissions], ['finance:read']);
    assert.match(job.actorLabel, /^service:NAY_FINANCEIRA@.+/);
    assert.equal(job.actorLabel, serviceLabel('NAY_FINANCEIRA', job.companyName));
    assert.ok(Object.isFrozen(job));
    // Desligada ou inexistente: o job não roda.
    await identities.updateServiceIdentity(ctx, criada.id, { enabled: false }, tx);
    await rejeita(loadServiceContext({ groupId: tenantA.groupId, companyId: tenantA.companyId }, 'NAY_FINANCEIRA', tx), 403, 'AI_SERVICE_IDENTITY_DISABLED');
    await rejeita(loadServiceContext({ groupId: tenantA.groupId, companyId: tenantA.companyId }, 'NAY_NAO_EXISTE', tx), 403, 'AI_SERVICE_IDENTITY_DISABLED');
  });
  // Usuário comum: ator USER com a lista do token.
  const u = buildUserContext({ userId: tenantA.userId, groupId: tenantA.groupId, companyId: tenantA.companyId, roles: ['X'], permissions: ['crm:opportunities:read'] }, { correlationId: 'c', runId: 'r' });
  assert.deepEqual(u.actor, { type: 'USER', userId: tenantA.userId });
  assert.deepEqual([...u.permissions], ['crm:opportunities:read']);
  assert.ok(Object.isFrozen(u) && Object.isFrozen(u.permissions));
  assert.equal(u.correlationId, 'c');
  assert.equal(u.runId, 'r');
});

test('m9d017_service_identity_isolada_por_empresa_e_com_rls', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await identities.createServiceIdentity(admin(tenantA), { agentCode: 'NAY_ESTOQUE', permissions: ['inventory:read'] }, tx);
    assert.equal((await identities.listServiceIdentities(admin(tenantA), tx)).length >= 1, true);
    const [rls] = await q(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forca FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'service_identities'`, {}, tx);
    assert.deepEqual(rls, { rls: true, forca: true });
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const lista = await identities.listServiceIdentities({ ...admin(tenantB) }, tx);
    assert.ok(lista.every((i) => i.agentCode !== 'NAY_ESTOQUE' || i.companyId === tenantB.companyId));
    const [{ n }] = await q('SELECT count(*)::int AS n FROM ai.service_identities WHERE company_id = :a', { a: tenantA.companyId }, tx);
    assert.equal(n, 0, 'a empresa B não enxerga identidade da A');
  });
});
