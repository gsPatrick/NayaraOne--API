'use strict';

// M9-D033 — regressão obrigatória: config_hash por versão, global_hash de agora, troca de prompt, modelo e provider barrada com
// 409 AI_REGRESSION_REQUIRED, e mudança global que não derruba versão ACTIVE. nayara_runtime (RLS real), com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const G = require('../_helpers/iaGolden');
const { overrideVersions } = require('../../../src/features/ai/regression');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenantA;
let pessoas;
before(async () => {
  ({ tenantA } = await G.prepararTenants());
  await G.carregarPessoas();
  pessoas = [G.ctxDe(tenantA), G.ctxDe(tenantA), G.ctxDe(tenantA), G.ctxDe(tenantA)].map((c) => c.userId);
  assert.ok(new Set(pessoas).size >= 3);
});
after(async () => { await G.sequelize.close(); });

const MENSAGEM = 'Troque o modelo somente depois de a regressão passar.';
const PROMPT_NOVO = 'Nunca invente dados. Cite as fontes. Responda em português.';

async function exigeRegressao(promessa) {
  const err = await G.rejeita(promessa, 409, 'AI_REGRESSION_REQUIRED');
  assert.equal(err.message, MENSAGEM);
  return err;
}

test('m9d033_avaliacao_grava_os_dois_hashes_e_homologar_os_exige', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, homologador] = pessoas;
    const { code, ev } = await G.agenteAvaliado(tenantA, tx, criador, disparador);
    assert.equal(ev.status, 'PASSED');
    const v1 = await G.agents.getVersion(G.como(tenantA, criador), code, 1, tx);
    assert.equal(ev.metrics.configHash, v1.configHash, 'config_hash da versão avaliada');
    assert.equal(ev.metrics.globalHash, await G.computeGlobalHash(G.como(tenantA, criador), tx), 'global_hash de agora');
    assert.match(ev.metrics.globalHash, /^[0-9a-f]{64}$/);
    // o global_hash nunca é gravado na linha do agente
    const linha = await G.q('SELECT * FROM ai.agents WHERE code = :c AND company_id = :co', { c: code, co: tenantA.companyId }, tx);
    assert.equal(Object.keys(linha[0]).some((k) => /global/i.test(k)), false);
    const ok = await G.agents.homologate(G.como(tenantA, homologador), code, 1, {}, tx);
    assert.equal(ok.status, 'HOMOLOGATED');
  });
});

test('m9d033_mudar_prompt_exige_nova_avaliacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, homologador] = pessoas;
    const { code, ev } = await G.agenteAvaliado(tenantA, tx, criador, disparador);
    // Mudar o prompt cria outra versão DRAFT com outro config_hash; a avaliação da v1 não vale para ela.
    const v2 = await G.agents.createVersion(G.como(tenantA, criador), code, { systemPolicy: PROMPT_NOVO }, tx);
    assert.equal(v2.version, 2);
    assert.equal(v2.status, 'DRAFT');
    assert.notEqual(v2.configHash, ev.metrics.configHash);
    await exigeRegressao(G.agents.homologate(G.como(tenantA, homologador), code, 2, {}, tx));
    const ev2 = await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all', agentVersion: 2 });
    assert.equal(ev2.status, 'PASSED');
    assert.equal(ev2.metrics.configHash, v2.configHash);
    assert.equal((await G.agents.homologate(G.como(tenantA, homologador), code, 2, {}, tx)).status, 'HOMOLOGATED');
  });
});

test('m9d033_editar_o_draft_depois_da_avaliacao_invalida_a_avaliacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, homologador] = pessoas;
    const { code } = await G.agenteAvaliado(tenantA, tx, criador, disparador);
    const editado = await G.agents.updateDraft(G.como(tenantA, criador), code, 1, { systemPolicy: PROMPT_NOVO }, tx);
    assert.equal(editado.status, 'DRAFT');
    await exigeRegressao(G.agents.homologate(G.como(tenantA, homologador), code, 1, {}, tx));
  });
});

test('m9d033_mudar_modelo_sem_regressao_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador] = pessoas;
    const politica = { capability: 'chat', provider: 'ai-sandbox', model: 'sandbox-1' };
    const { code } = await G.criarAgente(tenantA, tx, criador, { extra: { modelPolicy: politica } });
    // PUT do agente (DRAFT) trocando só o modelo, sem avaliação do novo par.
    await exigeRegressao(G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { ...politica, model: 'sandbox-b-1' } }, tx));
    // Nova versão a partir da anterior com outro modelo: idem.
    await exigeRegressao(G.agents.createVersion(G.como(tenantA, criador), code, { modelPolicy: { ...politica, model: 'sandbox-b-1' } }, tx));
    // Avaliar o agente com o perfil que produz esse modelo libera a troca.
    const ev = await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all', providerCode: 'sandbox-b' });
    assert.equal(ev.status, 'PASSED');
    assert.equal(ev.modelCode, 'sandbox-b-1');
    const trocado = await G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { ...politica, provider: 'sandbox-b', model: 'sandbox-b-1' } }, tx);
    assert.equal(trocado.modelPolicy.model, 'sandbox-b-1');
    // Gravar a mesma política de novo não é troca.
    assert.ok(await G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: trocado.modelPolicy, purpose: 'Responder com fontes.' }, tx));
  });
});

test('m9d033_mudar_provider_sem_regressao_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador, { extra: { modelPolicy: { capability: 'chat', provider: 'ai-sandbox' } } });
    await exigeRegressao(G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { capability: 'chat', provider: 'sandbox-a' } }, tx));
    // Avaliação de outro agente com o mesmo provedor não vale: a regressão é do agente.
    const outro = await G.agenteAvaliado(tenantA, tx, criador, disparador, { providerCode: 'sandbox-a' });
    assert.equal(outro.ev.status, 'PASSED');
    await exigeRegressao(G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { capability: 'chat', provider: 'sandbox-a' } }, tx));
    // Suíte só golden não basta (a regressão é golden + adversarial ou all).
    await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'golden', providerCode: 'sandbox-a' });
    await exigeRegressao(G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { capability: 'chat', provider: 'sandbox-a' } }, tx));
    await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'adversarial', providerCode: 'sandbox-a' });
    const ok = await G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { capability: 'chat', provider: 'sandbox-a' } }, tx);
    assert.equal(ok.modelPolicy.provider, 'sandbox-a');
    // Formato inválido do par é recusado antes.
    await G.rejeita(G.agents.updateDraft(G.como(tenantA, criador), code, 1, { modelPolicy: { provider: 'Provedor Inválido!' } }, tx), 400, 'AI_AGENT_INVALID');
  });
});

test('m9d033_provedor_e_modelo_padrao_da_empresa_exigem_regressao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador] = pessoas;
    const ctx = G.como(tenantA, criador);
    await exigeRegressao(upsertSetting('ia.provedor.padrao', 'sandbox-b', ctx, criador, tx));
    await exigeRegressao(upsertSetting('ia.provedor.modelo_padrao', 'sandbox-1', ctx, criador, tx));
    const antes = await G.computeGlobalHash(ctx, tx);
    await G.agenteAvaliado(tenantA, tx, criador, disparador, { providerCode: 'sandbox-b' });
    await upsertSetting('ia.provedor.padrao', 'sandbox-b', ctx, criador, tx);
    const depois = await G.computeGlobalHash(ctx, tx);
    assert.notEqual(antes, depois, 'o provedor padrão entra no global_hash');
    // o modelo do par também precisa ter sido avaliado
    await exigeRegressao(upsertSetting('ia.provedor.modelo_padrao', 'sandbox-1', ctx, criador, tx));
    await upsertSetting('ia.provedor.modelo_padrao', 'sandbox-b-1', ctx, criador, tx);
    assert.notEqual(await G.computeGlobalHash(ctx, tx), depois, 'o modelo padrão entra no global_hash');
    // repetir o valor atual não é troca
    await upsertSetting('ia.provedor.padrao', 'sandbox-b', ctx, criador, tx);
    await G.rejeita(upsertSetting('ia.provedor.modelo_padrao', 'Modelo Inválido!', ctx, criador, tx), 400, 'SETTING_INVALID_VALUE');
  });
});

test('m9d033_mudanca_global_nao_derruba_versao_active', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, homologador, ativador] = pessoas;
    const { code, ev } = await G.agenteAvaliado(tenantA, tx, criador, disparador);
    await G.agents.homologate(G.como(tenantA, homologador), code, 1, {}, tx);
    await G.svc.homologate(G.como(tenantA, criador, 'ai:evaluate'), ev.id, {}, tx);
    assert.equal((await G.agents.activate(G.como(tenantA, ativador), code, 1, tx)).status, 'ACTIVE');
    const hashAntes = await G.computeGlobalHash(G.como(tenantA, criador), tx);
    // Deploy muda a versão do roteador e a dos padrões de injeção.
    const restaura = overrideVersions({ router: () => 2, injection: () => 99 });
    try {
      assert.notEqual(await G.computeGlobalHash(G.como(tenantA, criador), tx), hashAntes);
      // A versão ACTIVE continua ACTIVE, habilitada e em uso.
      const ativa = await G.agents.getVersion(G.como(tenantA, criador), code, 1, tx);
      assert.equal(ativa.status, 'ACTIVE');
      assert.equal(ativa.enabled, true);
      // Outra versão (v2) só homologa com a avaliação do global_hash novo.
      await G.agents.createVersion(G.como(tenantA, criador), code, { systemPolicy: PROMPT_NOVO }, tx);
      const evAntiga = await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all', agentVersion: 2 });
      assert.notEqual(evAntiga.metrics.globalHash, hashAntes, 'a avaliação rodou contra o hash novo');
      assert.equal((await G.agents.homologate(G.como(tenantA, homologador), code, 2, {}, tx)).status, 'HOMOLOGATED');
    } finally { restaura(); }
    // Voltou o hash antigo: a avaliação feita com o hash novo deixa de valer para outra versão.
    await G.agents.createVersion(G.como(tenantA, criador), code, { systemPolicy: `${PROMPT_NOVO} v3` }, tx);
    const ev3 = await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all', agentVersion: 3 });
    const restaura2 = overrideVersions({ router: () => 3 });
    try {
      await exigeRegressao(G.agents.homologate(G.como(tenantA, homologador), code, 3, {}, tx));
      assert.equal(ev3.status, 'PASSED');
    } finally { restaura2(); }
    assert.equal((await G.agents.getVersion(G.como(tenantA, criador), code, 1, tx)).status, 'ACTIVE');
  });
});

test('m9d033_ativar_exige_avaliacao_homologada_do_hash_atual', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, homologador, ativador] = pessoas;
    const { code, ev } = await G.agenteAvaliado(tenantA, tx, criador, disparador);
    await G.agents.homologate(G.como(tenantA, homologador), code, 1, {}, tx);
    await G.svc.homologate(G.como(tenantA, criador, 'ai:evaluate'), ev.id, {}, tx);
    const restaura = overrideVersions({ router: () => 7 });
    try {
      await exigeRegressao(G.agents.activate(G.como(tenantA, ativador), code, 1, tx));
    } finally { restaura(); }
    assert.equal((await G.agents.activate(G.como(tenantA, ativador), code, 1, tx)).status, 'ACTIVE');
  });
});
