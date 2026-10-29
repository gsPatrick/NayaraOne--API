'use strict';

// M9-D004 — ai.agents e ai.agent_tools no banco: imutabilidade, uma ativa, CHECKs, RLS e seed dos oito agentes.
// Rodar em banco descartável (node scripts/withDisposableDb.js ...); usa o seed de dois tenants.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../testHelpers');
const {
  sequelize, uid, q, run, inserirAgente, levarPara, prepararTenants, expectDbError,
} = require('../helpers/aiAgents');

let tenantA;
let tenantB;
const OITO = ['NAY_DIRETORIA', 'NAY_COMERCIAL', 'NAY_FINANCEIRA', 'NAY_OBRAS', 'NAY_JURIDICA', 'NAY_CORRESPONDENTE', 'NAY_DOCUMENTAL', 'NAY_ATENDIMENTO'];

before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('migration_cria_as_duas_tabelas_com_rls_force_e_grant', async () => {
  for (const tabela of ['agents', 'agent_tools']) {
    const [r] = await q(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
              has_table_privilege('nayara_runtime', c.oid, 'SELECT') AS sel, has_table_privilege('nayara_runtime', c.oid, 'INSERT') AS ins
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = :t`, { t: tabela }
    );
    assert.ok(r, `ai.${tabela} não existe`);
    assert.equal(r.relrowsecurity, true);
    assert.equal(r.relforcerowsecurity, true);
    assert.ok(r.politicas >= 1);
    assert.ok(r.sel && r.ins, 'GRANT ao nayara_runtime');
  }
});

test('m9d004_versao_ativa_imutavel_por_trigger', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await inserirAgente(tenantA, tx);
    await levarPara(a.id, 'ACTIVE', tx);
    await expectDbError(tx, "UPDATE ai.agents SET purpose = 'outro' WHERE id = :id", { id: a.id }, /AI_AGENT_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.agents SET system_policy = 'x' WHERE id = :id", { id: a.id }, /AI_AGENT_IMMUTABLE/);
    await expectDbError(tx, 'DELETE FROM ai.agents WHERE id = :id', { id: a.id }, /AI_AGENT_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.agents SET status = 'DRAFT' WHERE id = :id", { id: a.id }, /AI_AGENT_TRANSITION/);
    // Aposentar é permitido e o conteúdo continua intocável.
    await run("UPDATE ai.agents SET status = 'RETIRED', enabled = false, retired_at = now() WHERE id = :id", { id: a.id }, tx);
    await expectDbError(tx, "UPDATE ai.agents SET purpose = 'outro' WHERE id = :id", { id: a.id }, /AI_AGENT_IMMUTABLE/);
  });
});

test('m9d004_trigger_barra_ativar_sem_homologar_e_voltar_para_draft', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await inserirAgente(tenantA, tx);
    await expectDbError(tx, "UPDATE ai.agents SET status = 'ACTIVE', enabled = true, activated_at = now() WHERE id = :id", { id: a.id }, /AI_AGENT_TRANSITION|AI_AGENT_NOT_HOMOLOGATED/);
    await levarPara(a.id, 'HOMOLOGATED', tx);
    await expectDbError(tx, "UPDATE ai.agents SET status = 'DRAFT' WHERE id = :id", { id: a.id }, /AI_AGENT_TRANSITION/);
  });
});

test('m9d004_uma_ativa_por_code', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const v1 = await inserirAgente(tenantA, tx, { code: 'UMA_ATIVA', version: 1 });
    const v2 = await inserirAgente(tenantA, tx, { code: 'UMA_ATIVA', version: 2 });
    await levarPara(v1.id, 'ACTIVE', tx);
    await levarPara(v2.id, 'HOMOLOGATED', tx);
    await expectDbError(tx, "UPDATE ai.agents SET status = 'ACTIVE', enabled = true WHERE id = :id", { id: v2.id }, /ai_agents_one_active_uq/);
    await expectDbError(tx, `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, criticality, config_hash)
      VALUES (gen_random_uuid(), :g, :c, 'UMA_ATIVA', 2, 'DRAFT', 'x', 'NON_CRITICAL', :h)`, { g: tenantA.groupId, c: tenantA.companyId, h: 'a'.repeat(64) }, /ai_agents_company_code_version_uq/);
  });
});

test('m9d004_high_exige_aprovacao_humana_check', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await inserirAgente(tenantA, tx);
    const ins = (risco, aprov) => run(
      `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval)
       VALUES (gen_random_uuid(), :g, :c, :a, :t, 'ai:read', :r, :h)`,
      { g: tenantA.groupId, c: tenantA.companyId, a: a.id, t: `tool_${uid().slice(0, 6)}`, r: risco, h: aprov }, tx
    );
    for (const risco of ['HIGH', 'CRITICAL']) {
      await expectDbError(tx, `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval)
        VALUES (gen_random_uuid(), :g, :c, :a, 'x_${risco}', 'ai:read', :r, false)`, { g: tenantA.groupId, c: tenantA.companyId, a: a.id, r: risco }, /agent_tools_high_approval_chk/);
    }
    await ins('HIGH', true);
    await ins('LOW', false);
    await run(`INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level)
      VALUES (gen_random_uuid(), :g, :c, :a, 'unica', 'ai:read', 'LOW')`, { g: tenantA.groupId, c: tenantA.companyId, a: a.id }, tx);
    await expectDbError(tx, `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level)
      VALUES (gen_random_uuid(), :g, :c, :a, 'unica', 'ai:read', 'LOW')`, { g: tenantA.groupId, c: tenantA.companyId, a: a.id }, /agent_tools_agent_tool_uq/);
  });
});

test('m9d004_allowlist_so_muda_com_agente_em_draft', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await inserirAgente(tenantA, tx);
    await run(`INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level)
      VALUES (gen_random_uuid(), :g, :c, :a, 'lista', 'ai:read', 'LOW')`, { g: tenantA.groupId, c: tenantA.companyId, a: a.id }, tx);
    await levarPara(a.id, 'ACTIVE', tx);
    await expectDbError(tx, "UPDATE ai.agent_tools SET enabled = false WHERE agent_id = :a", { a: a.id }, /AI_AGENT_IMMUTABLE/);
    await expectDbError(tx, 'DELETE FROM ai.agent_tools WHERE agent_id = :a', { a: a.id }, /AI_AGENT_IMMUTABLE/);
    await expectDbError(tx, `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level)
      VALUES (gen_random_uuid(), :g, :c, :a, 'nova', 'ai:read', 'LOW')`, { g: tenantA.groupId, c: tenantA.companyId, a: a.id }, /AI_AGENT_IMMUTABLE/);
  });
});

test('m9d004_agente_sem_purpose_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await expectDbError(tx, `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, criticality, config_hash)
      VALUES (gen_random_uuid(), :g, :c, 'SEM_PURPOSE', 1, 'DRAFT', '   ', 'NON_CRITICAL', :h)`, { g: tenantA.groupId, c: tenantA.companyId, h: 'a'.repeat(64) }, /agents_purpose_chk/);
    await expectDbError(tx, `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, criticality, config_hash)
      VALUES (gen_random_uuid(), :g, :c, 'SEM_PURPOSE', 1, 'DRAFT', 'NON_CRITICAL', :h)`, { g: tenantA.groupId, c: tenantA.companyId, h: 'a'.repeat(64) }, /purpose/);
  });
});

test('m9d004_empresa_b_nao_ve_agente_da_a_e_ve_o_padrao_do_sistema', async () => {
  let codigo;
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await inserirAgente(tenantA, tx);
    codigo = a.code;
    const [{ n }] = await q('SELECT count(*)::int AS n FROM ai.agents WHERE code = :c', { c: codigo }, tx);
    assert.equal(n, 1);
    await run('SAVEPOINT visao', {}, tx);
    // Empresa B com a mesma transação trocada de contexto: nenhuma linha da A.
    await run("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { g: tenantB.groupId, c: tenantB.companyId }, tx);
    const [{ nb }] = await q('SELECT count(*)::int AS nb FROM ai.agents WHERE code = :c', { c: codigo }, tx);
    assert.equal(nb, 0, 'a empresa B não pode ver o agente da A');
    const [{ sistema }] = await q('SELECT count(*)::int AS sistema FROM ai.agents WHERE company_id IS NULL', {}, tx);
    assert.ok(sistema >= 8, 'o padrão do sistema é legível por qualquer empresa');
    await expectDbError(tx, `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, criticality, config_hash)
      VALUES (gen_random_uuid(), :g, :c, 'FORJADO', 1, 'DRAFT', 'x', 'NON_CRITICAL', :h)`, { g: tenantA.groupId, c: tenantA.companyId, h: 'a'.repeat(64) }, /row-level security/);
    await expectDbError(tx, `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, criticality, config_hash)
      VALUES (gen_random_uuid(), NULL, NULL, 'SISTEMA_FORJADO', 1, 'DRAFT', 'x', 'NON_CRITICAL', :h)`, { h: 'a'.repeat(64) }, /row-level security/);
    const afetadas = await run("UPDATE ai.agents SET purpose = 'adulterado' WHERE company_id IS NULL", {}, tx);
    assert.equal(afetadas[1].rowCount, 0, 'empresa não altera o padrão do sistema');
  });
});

test('m9d004_seed_dos_oito_agentes_em_draft_desabilitados', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const linhas = await q("SELECT code, version, status, enabled, purpose, config_hash, criticality FROM ai.agents WHERE company_id IS NULL ORDER BY code", {}, tx);
    assert.deepEqual(linhas.map((l) => l.code).sort(), [...OITO].sort());
    for (const l of linhas) {
      assert.equal(l.version, 1);
      assert.equal(l.status, 'DRAFT', `${l.code} deve entrar em DRAFT`);
      assert.equal(l.enabled, false, `${l.code} deve entrar desabilitado`);
      assert.ok(l.purpose.trim().length > 10);
      assert.match(l.config_hash, /^[0-9a-f]{64}$/);
    }
    const ativos = await q("SELECT count(*)::int AS n FROM ai.agents WHERE status = 'ACTIVE' AND company_id IS NULL", {}, tx);
    assert.equal(ativos[0].n, 0);
  });
});

test('m9d004_hash_do_seed_confere_com_o_calculo_da_aplicacao', async () => {
  const { computeConfigHash } = require('../../src/features/ai/agents/agentConfigHash');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const linhas = await q('SELECT * FROM ai.agents WHERE company_id IS NULL', {}, tx);
    assert.equal(linhas.length, 8);
    for (const l of linhas) {
      // A allowlist do padrão do sistema entra no hash (agentes com conteúdo, M9-D037 em diante): lida da própria tabela.
      const tools = (await q('SELECT tool_name, permission_code, risk_level, requires_human_approval, enabled FROM ai.agent_tools WHERE agent_id = :id', { id: l.id }, tx))
        .map((t) => ({ toolName: t.tool_name, permissionCode: t.permission_code, riskLevel: t.risk_level, requiresHumanApproval: t.requires_human_approval, enabled: t.enabled }));
      const esperado = computeConfigHash({
        code: l.code, purpose: l.purpose, systemPolicy: l.system_policy, modelPolicy: l.model_policy, dataScopes: l.data_scopes,
        limits: l.limits, criticality: l.criticality, tools,
      });
      assert.equal(l.config_hash, esperado, `hash do seed de ${l.code}`);
    }
  });
});
