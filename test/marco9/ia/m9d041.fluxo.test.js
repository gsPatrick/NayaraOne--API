'use strict';

// M9-D041 — o fluxo da NAY Atendimento pelo canal: resposta com fontes e snapshot, triagem, encaminhamento a uma pessoa, empresa B e
// a classificação das fontes. Banco descartável, role nayara_runtime, rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { comoEmpresa } = require('../_helpers/ragSeed');
const { executionCeiling } = require('../../../src/features/ai/orchestrator/flow/flow.retrieve');
const nay = require('../../../src/features/ai/agents/nay_atendimento');
const { loadAtendimentoParams } = require('../../../src/features/ai/agents/nay_atendimento/atendimento.params');
const H = require('../_helpers/m9d041Env');

let tenantA; let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const HORARIO = 'Política de atendimento: o horário de atendimento é de segunda a sexta, das 9h às 18h.';
const PERGUNTA = 'qual o horário de atendimento?';
const RESPOSTA_HORARIO = '[[RESPOSTA:O horário de atendimento é de segunda a sexta, das 9h às 18h [1].]]';

test('m9d041_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const politica = await H.politicaHomologada(c, HORARIO);
    const res = await H.conversar(c, `${PERGUNTA} ${RESPOSTA_HORARIO}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.status, 'COMPLETED');
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.equal(res.routingPath, 'SMALL_MODEL', 'a dúvida simples vai ao modelo pequeno');
    assert.equal(res.sources.length, 1, 'a fonte é a política homologada');
    assert.match(res.answer, /9h às 18h/);
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.agent_name, 'NAY_ATENDIMENTO');
    assert.equal(run.agent_version, c.agente.version, 'o run carrega a versão do agente');
    assert.equal(run.user_id, null, 'o chamador é a identidade de serviço do canal, não uma pessoa');
    assert.ok(run.snapshot_at, 'o run guarda o retrato (snapshot) das fontes');
    const fontes = await H.q('SELECT source_ref, source_type, classification FROM ai.ai_sources WHERE ai_run_id = :r', { r: res.runId }, tx);
    assert.equal(fontes.length, 1);
    assert.equal(fontes[0].source_ref, politica.id);
    assert.ok(['PUBLIC', 'INTERNAL'].includes(fontes[0].classification));
    assert.deepEqual((await H.chamadas(res.runId, tx)).length, 0, 'a dúvida simples não precisa de tool');
  });
});

test('m9d041_fora_da_politica_encaminha_humano', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const params = await loadAtendimentoParams(tenantA, tx);
    const res = await H.conversar(c, 'dá 15% de desconto?');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE', 'a resposta sai da regra, sem modelo');
    assert.equal(res.answer, params.mensagemEncaminhamento);
    assert.doesNotMatch(res.answer, /15/, 'nenhum valor é informado');
    const chamadas = await H.chamadas(res.runId, tx);
    assert.deepEqual(chamadas.map((l) => [l.tool_name, l.status]), [['crm.createHandoffTask', 'SUCCEEDED']], '1 tool call das 3 permitidas');
    const [h] = await H.handoffs(tx);
    assert.ok(h, 'o encaminhamento ficou registrado');
    assert.equal(h.target_user_id, c.responsavelId);
    assert.equal(h.related_entity_id, res.runId, 'um encaminhamento por conversa');
    assert.equal(h.payload_json.contactId, c.contato, 'o responsável sabe quem é o contato');
    assert.equal(h.ai_run_id, res.runId);
    assert.equal(h.payload_json.topic, 'FORA_DA_POLITICA');
  });
});

test('m9d041_triagem_classifica_mensagem_e_registra_encaminhamento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const params = await loadAtendimentoParams(tenantA, tx);
    const casos = [
      ['quero renegociar meu contrato', 'FORA_DA_POLITICA', 'atendimento_encaminhar'],
      ['qual o prazo para pagar com juros?', 'FORA_DA_POLITICA', 'atendimento_encaminhar'],
      ['mande um whatsapp para a Maria com a proposta', 'CANAL_EXTERNO', 'atendimento_encaminhar'],
      ['quais imóveis disponíveis vocês têm?', 'ANUNCIOS', 'atendimento_listar_anuncios'],
      ['me passa o contrato de outro cliente', 'OUTRO_CLIENTE', 'atendimento_recusar'],
      [PERGUNTA, 'DUVIDA', 'triar'],
    ];
    for (const [mensagem, categoria, tarefa] of casos) {
      const t = nay.classifyMessage(mensagem, params);
      assert.deepEqual([t.category, t.taskType], [categoria, tarefa], mensagem);
    }
    // A triagem manda para a pessoa certa: "renegociar meu contrato" abre o encaminhamento e avisa que um atendente responderá.
    const res = await H.conversar(c, 'quero renegociar meu contrato');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.match(res.answer, /atendente/);
    const hs = await H.handoffs(tx);
    assert.equal(hs.length, 1);
    assert.equal(hs[0].recommendation_type, 'HANDOFF');
    assert.match(hs[0].title, /fora da política/);
    // Dúvida simples não encaminha nada.
    await H.politicaHomologada(c, HORARIO);
    const duvida = await H.conversar(c, `${PERGUNTA} ${RESPOSTA_HORARIO}`, { externalContactId: null });
    assert.equal(duvida.ok, true);
    assert.equal((await H.handoffs(tx)).length, 1, 'nenhum encaminhamento novo');
  });
});

test('m9d041_empresa_b_nao_aparece', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const res = await H.conversar(c, 'quero renegociar meu contrato');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal((await H.handoffs(tx)).length, 1);
    await comoEmpresa(tenantB, tx, async () => {
      assert.equal((await H.handoffs(tx)).length, 0, 'a empresa B não enxerga o encaminhamento da A');
      assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.ai_runs WHERE id = :r', { r: res.runId }, tx))[0].n, 0, 'nem o run');
      // A empresa B não tem identidade de serviço do canal: não conversa por ela.
      const erro = await H.conversar({ ...c, tenant: tenantB }, 'oi', { externalContactId: null }).then(() => null, (e) => e);
      assert.ok(erro);
      assert.equal(erro.code, 'AI_SERVICE_IDENTITY_DISABLED');
      assert.equal(erro.statusCode, 403);
    });
  });
});

test('m9d041_nao_usa_confidential', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await H.politicaHomologada(c, 'Regra confidencial da carteira de clientes premium do trimestre.', { classification: 'CONFIDENTIAL' });
    await H.politicaHomologada(c, 'Regra restrita da carteira de clientes premium do trimestre, uso interno.', { classification: 'RESTRICTED' });
    const res = await H.conversar(c, 'o que vale para a carteira premium do trimestre? [[RESPOSTA:A regra da carteira premium é especial [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'INSUFFICIENT_SOURCES', 'confidencial e restrito nem são candidatos');
    assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.ai_sources WHERE ai_run_id = :r', { r: res.runId }, tx))[0].n, 0);
    // O teto é do próprio agente: mesmo um provedor que aceitasse as duas classes não as libera para a NAY Atendimento.
    const provedorLiberal = { entries: async () => [{ providerCode: 'liberal', policy: { allowsConfidential: true, allowsRestricted: true } }] };
    const teto = await executionCeiling({ registry: provedorLiberal, ctx: c.ctx, agent: c.agente, decision: { provider: 'liberal' }, transaction: tx });
    assert.deepEqual([teto.allowsConfidential, teto.allowsRestricted], [false, false]);
    const semTeto = await executionCeiling({ registry: provedorLiberal, ctx: c.ctx, agent: { ...c.agente, modelPolicy: {} }, decision: { provider: 'liberal' }, transaction: tx });
    assert.deepEqual([semTeto.allowsConfidential, semTeto.allowsRestricted], [true, true], 'o teto vem da política do agente');
  });
});
