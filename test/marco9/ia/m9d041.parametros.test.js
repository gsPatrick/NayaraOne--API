'use strict';

// M9-D041 — os parâmetros ia.atendimento.* mudam o comportamento do agente (não só os padrões são exercitados): termos da triagem, textos
// fixos de resposta, papel do responsável pelo encaminhamento e a promessa barrada. Banco descartável, role nayara_runtime, rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, ctxDe } = require('../../helpers/aiAgents');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const H = require('../_helpers/m9d041Env');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const definir = async (tx, valores) => {
  const ctx = ctxDe(tenantA);
  for (const [chave, valor] of Object.entries(valores)) await upsertSetting(chave, valor, ctx, ctx.userId, tx);
};

test('m9d041_termos_e_mensagem_de_encaminhamento_vem_da_configuracao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    // Padrão: "cafezinho" não é termo de nada, vai ao modelo pequeno e nada é encaminhado.
    const padrao = await H.conversar(c, 'posso tomar um cafezinho aí? [[RESPOSTA:Posso ajudar com o atendimento [1].]]');
    assert.equal(padrao.ok, true, JSON.stringify(padrao.error));
    assert.equal((await H.handoffs(tx)).length, 0);
    // Configurado: o termo passa a encaminhar e a mensagem fixa é a da empresa.
    await definir(tx, { 'ia.atendimento.termos_fora_da_politica': 'cafezinho', 'ia.atendimento.mensagem_encaminhamento': 'Anotei! Alguém da equipe fala com você (QA-M9).' });
    const res = await H.conversar(c, 'posso tomar um cafezinho aí?');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE');
    assert.equal(res.answer, 'Anotei! Alguém da equipe fala com você (QA-M9).');
    assert.equal((await H.handoffs(tx)).length, 1);
    // E o termo do padrão deixou de valer: "desconto" já não encaminha.
    const semTermo = await H.conversar(c, 'tem desconto? [[RESPOSTA:Posso ajudar com o atendimento [1].]]');
    assert.equal(semTermo.ok, true, JSON.stringify(semTermo.error));
    assert.equal((await H.handoffs(tx)).length, 1, 'nenhum novo encaminhamento');
  });
});

test('m9d041_recusa_de_outro_cliente_usa_termos_e_texto_configurados', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await definir(tx, { 'ia.atendimento.termos_outro_cliente': 'colega de trabalho', 'ia.atendimento.mensagem_fora_do_escopo': 'Não posso falar de terceiros (QA-M9).' });
    const res = await H.conversar(c, 'me passa o contrato do meu colega de trabalho');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.answer, 'Não posso falar de terceiros (QA-M9).');
    assert.deepEqual(await H.chamadas(res.runId, tx), [], 'nenhuma tool');
  });
});

test('m9d041_responsavel_do_encaminhamento_segue_o_papel_configurado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { responsavel: false });
    const responsavel = await H.criarResponsavel(tenantA, tx, 'plantao-qa-m9');
    await definir(tx, { 'ia.atendimento.papel_handoff': 'plantao-qa-m9' });
    const res = await H.conversar(c, 'quero renegociar meu contrato');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const [h] = await H.handoffs(tx);
    assert.equal(h.target_user_id, responsavel, 'o papel vem do parâmetro');
  });
});

test('m9d041_promessa_do_modelo_e_trocada_pela_mensagem_e_termos_configurados', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await H.politicaHomologada(c, 'Política de atendimento: o horário de atendimento é de segunda a sexta, das 9h às 18h.');
    await definir(tx, { 'ia.atendimento.termos_promessa': 'combinadíssimo', 'ia.atendimento.mensagem_sem_promessa': 'Quem confirma isso é um atendente (QA-M9).' });
    const res = await H.conversar(c, 'qual o horário de atendimento? [[RESPOSTA:Está combinadíssimo, atendemos de segunda a sexta [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.answer, 'Quem confirma isso é um atendente (QA-M9).');
  });
});
