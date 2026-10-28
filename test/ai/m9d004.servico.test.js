'use strict';

// M9-D004 — serviço de agentes versionados: ciclo DRAFT -> HOMOLOGATED -> ACTIVE -> RETIRED, imutabilidade, segregação,
// allowlist de tools e resolução da versão ativa. Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { withRollbackTenantTransaction } = require('../testHelpers');
const { upsertSetting } = require('../../src/features/settings/settings.service');
const agents = require('../../src/modules/ai/agents');
const {
  carregarPessoas, sequelize, uid, q, ctxDe, BASE_AGENT, FERRAMENTA, prepararTenants,
} = require('../helpers/aiAgents');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const codigoNovo = () => `T_${uid().slice(0, 8).toUpperCase()}`;
async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}
const semAvaliacao = (ctx, tx) => upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, tx);
const corpo = (extra = {}) => ({ ...BASE_AGENT, tools: [FERRAMENTA], ...extra });

test('m9d004_ciclo_criar_v2_homologar_ativar_aposenta_a_v1_na_mesma_transacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const criador = ctxDe(tenantA); const avaliador = ctxDe(tenantA); const admin = ctxDe(tenantA, criador.userId);
    await semAvaliacao(criador, tx);
    const code = codigoNovo();
    const v1 = await agents.createVersion(criador, code, corpo(), tx);
    assert.equal(v1.version, 1); assert.equal(v1.status, 'DRAFT'); assert.equal(v1.enabled, false);
    assert.equal(v1.tools.length, 1);
    await agents.homologate(avaliador, code, 1, { note: 'ok' }, tx);
    const ativa1 = await agents.activate(admin, code, 1, tx);
    assert.equal(ativa1.status, 'ACTIVE'); assert.equal(ativa1.enabled, true);

    const v2 = await agents.createVersion(criador, code, { purpose: 'Nova finalidade do agente.' }, tx);
    assert.equal(v2.version, 2); assert.equal(v2.purpose, 'Nova finalidade do agente.');
    assert.equal(v2.tools.length, 1, 'a v2 copia a allowlist da v1');
    await agents.homologate(avaliador, code, 2, { note: 'ok' }, tx);
    await agents.activate(admin, code, 2, tx);
    const lista = await agents.listVersions(admin, code, tx);
    assert.deepEqual(lista.map((v) => [v.version, v.status]), [[2, 'ACTIVE'], [1, 'RETIRED']]);
    assert.equal(lista[1].enabled, false);
  });
});

test('m9d004_ativar_sem_homologacao_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA); const code = codigoNovo();
    await agents.createVersion(ctx, code, corpo(), tx);
    const err = await rejeita(agents.activate(ctx, code, 1, tx), 409, 'AI_AGENT_NOT_HOMOLOGATED');
    assert.match(err.message, /avaliação verde e homologação humana/);
  });
});

test('m9d004_editar_versao_ativa_409_imutavel_e_draft_editavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const criador = ctxDe(tenantA); const avaliador = ctxDe(tenantA); const code = codigoNovo();
    await semAvaliacao(criador, tx);
    const draft = await agents.createVersion(criador, code, corpo(), tx);
    const editado = await agents.updateDraft(criador, code, 1, { purpose: 'Finalidade revisada do agente.' }, tx);
    assert.equal(editado.purpose, 'Finalidade revisada do agente.');
    assert.notEqual(editado.configHash, draft.configHash, 'o hash acompanha o conteúdo enquanto é DRAFT');
    await agents.homologate(avaliador, code, 1, {}, tx);
    await agents.activate(criador, code, 1, tx);
    const err = await rejeita(agents.updateDraft(criador, code, 1, { purpose: 'Outra finalidade qualquer.' }, tx), 409, 'AI_AGENT_IMMUTABLE');
    assert.match(err.message, /Versão ativa não pode ser editada; crie uma nova versão\./);
    await rejeita(agents.setTools(criador, code, 1, [], tx), 409, 'AI_AGENT_IMMUTABLE');
  });
});

test('m9d004_homologador_diferente_do_criador', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const criador = ctxDe(tenantA); const code = codigoNovo();
    await semAvaliacao(criador, tx);
    await agents.createVersion(criador, code, corpo(), tx);
    await rejeita(agents.homologate(criador, code, 1, {}, tx), 403, 'AI_AGENT_SEGREGATION');
    // O ativador também não pode ser quem homologou.
    const avaliador = ctxDe(tenantA);
    await agents.homologate(avaliador, code, 1, {}, tx);
    await rejeita(agents.activate(avaliador, code, 1, tx), 403, 'AI_AGENT_SEGREGATION');
    // Configurável: com a segregação desligada, a mesma pessoa pode.
    await upsertSetting('ia.agente.segregacao_funcoes', false, criador, criador.userId, tx);
    const code2 = codigoNovo();
    await agents.createVersion(criador, code2, corpo(), tx);
    const ok = await agents.homologate(criador, code2, 1, {}, tx);
    assert.equal(ok.status, 'HOMOLOGATED');
  });
});

test('m9d004_homologar_exige_avaliacao_verde_por_padrao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const criador = ctxDe(tenantA); const code = codigoNovo();
    await agents.createVersion(criador, code, corpo(), tx);
    // Sem a tabela de avaliações entregue (D032) ou sem avaliação aprovada, o padrão do livro barra a homologação.
    await rejeita(agents.homologate(ctxDe(tenantA), code, 1, {}, tx), 409, 'AI_AGENT_EVALUATION_REQUIRED');
  });
});

test('m9d004_avaliacao_verde_aprovada_libera_a_homologacao', { skip: process.env.DISPOSABLE_DB === '1' && process.env.DATABASE_ADMIN_URL ? false : 'precisa do cluster descartável' }, async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  const existia = (await admin.query("SELECT to_regclass('ai.evaluations') AS t")).rows[0].t;
  const code = codigoNovo();
  try {
    if (!existia) {
      // Tabela mínima no cluster descartável: a definitiva é da M9-D032; aqui só os campos que a homologação consulta.
      await admin.query(`CREATE TABLE ai.evaluations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid, company_id uuid,
        agent_code text, agent_version int, suite text, status text)`);
      await admin.query('GRANT SELECT ON ai.evaluations TO nayara_runtime');
    }
    await admin.query("INSERT INTO ai.evaluations (group_id, company_id, agent_code, agent_version, suite, status) VALUES ($1, $2, $3, 1, 'ALL', 'FAILED')", [tenantA.groupId, tenantA.companyId, code]);
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      const criador = ctxDe(tenantA);
      await agents.createVersion(criador, code, corpo(), tx);
      await rejeita(agents.homologate(ctxDe(tenantA), code, 1, {}, tx), 409, 'AI_AGENT_EVALUATION_REQUIRED');
    });
    await admin.query("INSERT INTO ai.evaluations (group_id, company_id, agent_code, agent_version, suite, status) VALUES ($1, $2, $3, 1, 'ALL', 'PASSED')", [tenantA.groupId, tenantA.companyId, code]);
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      await agents.createVersion(ctxDe(tenantA), code, corpo(), tx);
      const ok = await agents.homologate(ctxDe(tenantA), code, 1, {}, tx);
      assert.equal(ok.status, 'HOMOLOGATED');
    });
  } finally {
    if (existia) await admin.query('DELETE FROM ai.evaluations WHERE agent_code = $1', [code]);
    else await admin.query('DROP TABLE IF EXISTS ai.evaluations');
    await admin.end();
  }
});

test('m9d004_agente_sem_purpose_recusado_e_codigo_invalido', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ purpose: '   ' }), tx), 400, 'AI_AGENT_INVALID');
    const { purpose, ...semPurpose } = BASE_AGENT;
    await rejeita(agents.createVersion(ctx, codigoNovo(), semPurpose, tx), 400, 'AI_AGENT_INVALID');
    await rejeita(agents.createVersion(ctx, 'minusculo', corpo(), tx), 400, 'AI_AGENT_INVALID');
    await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ criticality: 'X' }), tx), 400, 'AI_AGENT_INVALID');
    await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ limits: { max_tool_calls_por_run: 0 } }), tx), 400, 'AI_AGENT_INVALID');
    await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ limits: { inventado: 3 } }), tx), 400, 'AI_AGENT_INVALID');
  });
});

test('m9d004_high_exige_aprovacao_humana_no_servico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const alta = { ...FERRAMENTA, toolName: 'fin.pagar', riskLevel: 'HIGH', requiresHumanApproval: false };
    const err = await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ tools: [alta] }), tx), 400, 'AI_AGENT_TOOL_INVALID');
    assert.match(err.message, /Ferramenta de risco alto exige aprovação humana\./);
    await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ tools: [{ ...FERRAMENTA, permissionCode: 'nao:existe' }] }), tx), 400, 'AI_AGENT_TOOL_INVALID');
    await rejeita(agents.createVersion(ctx, codigoNovo(), corpo({ tools: [FERRAMENTA, FERRAMENTA] }), tx), 400, 'AI_AGENT_TOOL_INVALID');
    const ok = await agents.createVersion(ctx, codigoNovo(), corpo({ tools: [{ ...alta, requiresHumanApproval: true }] }), tx);
    assert.equal(ok.tools[0].requiresHumanApproval, true);
  });
});

test('m9d004_tool_fora_da_allowlist_bloqueada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const criador = ctxDe(tenantA); const code = codigoNovo();
    await semAvaliacao(criador, tx);
    const desligada = { ...FERRAMENTA, toolName: 'crm.desligada', enabled: false };
    await agents.createVersion(criador, code, corpo({ tools: [FERRAMENTA, desligada] }), tx);
    await agents.homologate(ctxDe(tenantA), code, 1, {}, tx);
    await agents.activate(criador, code, 1, tx);
    const agente = await agents.resolveActiveAgent(code, criador, tx);
    assert.equal(agents.assertToolAllowed(agente, FERRAMENTA.toolName).permissionCode, 'ai:read');
    const err = await rejeita(Promise.resolve().then(() => agents.assertToolAllowed(agente, 'fin.pagar')), 403, 'AI_TOOL_NOT_ALLOWED');
    assert.match(err.message, /Este agente não pode usar esta ferramenta\./);
    await rejeita(Promise.resolve().then(() => agents.assertToolAllowed(agente, 'crm.desligada')), 403, 'AI_TOOL_NOT_ALLOWED');
    await rejeita(Promise.resolve().then(() => agents.assertToolAllowed(agente, '')), 403, 'AI_TOOL_NOT_ALLOWED');
  });
});

test('m9d004_resolucao_da_versao_ativa_empresa_depois_sistema_senao_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    // Os oito do sistema estão em DRAFT e desabilitados: ninguém resolve.
    const err = await rejeita(agents.resolveActiveAgent('NAY_COMERCIAL', ctx, tx), 409, 'AI_AGENT_DISABLED');
    assert.deepEqual(err.details, { agent: 'NAY_COMERCIAL' });
    // Empresa cria a sua a partir do padrão do sistema (copia a v1 do sistema) e ativa.
    await semAvaliacao(ctx, tx);
    const nova = await agents.createVersion(ctx, 'NAY_COMERCIAL', {}, tx);
    assert.equal(nova.version, 1); assert.equal(nova.companyId, tenantA.companyId);
    assert.match(nova.purpose, /\S/);
    await agents.homologate(ctxDe(tenantA), 'NAY_COMERCIAL', 1, {}, tx);
    await agents.activate(ctx, 'NAY_COMERCIAL', 1, tx);
    const resolvida = await agents.resolveActiveAgent('nay_comercial', ctx, tx);
    assert.equal(resolvida.version, 1); assert.equal(resolvida.status, 'ACTIVE');
    const stamp = agents.runStamp(resolvida);
    assert.deepEqual(Object.keys(stamp).sort(), ['agentCode', 'agentId', 'agentVersion']);
    assert.equal(stamp.agentId, resolvida.id); assert.equal(stamp.agentVersion, 1);
    // Código que não existe em lugar nenhum.
    await rejeita(agents.resolveActiveAgent('NAY_NAO_EXISTE', ctx, tx), 409, 'AI_AGENT_DISABLED');
  });
});

test('m9d004_empresa_b_nao_ve_agente_da_a_no_servico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const code = codigoNovo();
    await agents.createVersion(ctxDe(tenantA), code, corpo(), tx);
    const noA = await agents.listVersions(ctxDe(tenantA), code, tx);
    assert.equal(noA.length, 1);
    await q("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { g: tenantB.groupId, c: tenantB.companyId }, tx);
    await rejeita(agents.getVersion(ctxDe(tenantB), code, 1, tx), 404, 'AI_AGENT_NOT_FOUND');
    assert.deepEqual(await agents.listVersions(ctxDe(tenantB), code, tx), []);
  });
});

test('m9d004_criar_versao_e_idempotente_com_a_mesma_chave', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA); const code = codigoNovo();
    const a = await agents.createVersion(ctx, code, corpo({ idempotencyKey: 'chave-1' }), tx);
    const b = await agents.createVersion(ctx, code, corpo({ idempotencyKey: 'chave-1' }), tx);
    assert.equal(b.id, a.id); assert.equal(b.replay, true);
    assert.equal((await agents.listVersions(ctx, code, tx)).length, 1);
  });
});

test('m9d004_hash_de_configuracao_e_estavel_e_muda_com_as_tools', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const a = await agents.createVersion(ctx, codigoNovo(), corpo(), tx);
    const b = await agents.createVersion(ctx, codigoNovo(), corpo(), tx);
    assert.match(a.configHash, /^[0-9a-f]{64}$/);
    const semCodigo = (x) => agents.computeConfigHash({ ...x, code: 'X' });
    assert.equal(semCodigo(a), semCodigo(b), 'mesmo conteúdo, mesmo hash');
    assert.deepEqual(a.permissions, ['ai:read'], 'AI-003: o agente possui as permissões das suas tools habilitadas');
    const c = await agents.setTools(ctx, a.code, 1, [], tx);
    assert.deepEqual(c.permissions, []);
    assert.notEqual(c.configHash, a.configHash, 'trocar a allowlist troca o hash');
  });
});
