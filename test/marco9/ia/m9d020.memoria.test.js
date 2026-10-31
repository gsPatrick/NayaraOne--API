'use strict';

// M9-D020 — memória no contexto do run (M9-D009): o orquestrador monta o contexto com as memórias VIGENTES por recallAsSources, passando
// pelo ContextBuilder da D027; memória invalidada, substituída ou expirada não aparece no contexto nem na resposta (repete
// `adv_memoria_invalidada_nao_reaparece` pelo fluxo do orquestrador, com o provider sandbox).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { registerTaskType, unregisterTaskType } = require('../../../src/features/ai/security');
const { MEMORY_CONTEXT_FIELDS } = require('../../../src/features/ai/memory');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { memoria, dados, origemRun, comPerm } = require('../_helpers/iaMemoria');
const { createAiAccess } = require('../_helpers/iaPrivacidade');
const { espiaRegistry } = require('../_helpers/iaEspia');
const H = require('../_helpers/iaOrquestrador');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); registerTaskType('priorizar_imoveis', { fields: [...MEMORY_CONTEXT_FIELDS] }); });
after(async () => { unregisterTaskType('priorizar_imoveis'); await sequelize.close(); });

const pergunta = '[[RESPOSTA:Priorizar o imóvel indicado pela diretoria [1].]]';
const dono = (c) => comPerm(c.ctx, 'ai:use');
const AGORA = { now: new Date(H.FIXO()) }; // o relógio do run é fixo no meio do mês do orçamento: a memória nasce vigente nesse instante
const texto = (pedidos) => JSON.stringify(pedidos.map((p) => p.messages));

test('adv_memoria_invalidada_nao_reaparece_pelo_orquestrador', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const aiAccess = createAiAccess();
    const c = await H.cenario(tenantA, tx, { deps: { registry, aiAccess } });
    const run = await origemRun(tenantA, tx);
    const salva = (await memoria.save(dono(c), dados(run, { value: { decision: 'prioridade: Aurora' } }), tx, AGORA)).memory;
    const consulta = (extra = {}) => H.rodar(c, `Qual imóvel priorizar? ${pergunta}`, { taskType: 'priorizar_imoveis', subject: { type: 'Property', id: salva.subjectId }, ...extra });
    // Vigente: entra no contexto (bloco untrusted com a origem para citação) e a resposta cita a fonte.
    const antes = await consulta();
    assert.equal(antes.ok, true, JSON.stringify(antes.error));
    assert.match(texto(pedidos), /prioridade: Aurora/, 'a memória vigente entra no contexto do run');
    assert.match(texto(pedidos), new RegExp(salva.sourceId), 'com a origem para citação');
    assert.equal(antes.groundingStatus, 'GROUNDED');
    assert.equal(antes.sources[0].type, 'MEMORY');
    assert.ok(aiAccess.calls.length >= 1, 'o ContextBuilder consultou o guarda de campos da IA');
    assert.equal((await H.fontes(antes.runId, tx))[0].source_type, 'MEMORY');
    // Invalidada: o run seguinte não a vê, nem no contexto nem na resposta.
    await memoria.invalidate(dono(c), salva.id, { reason: 'Informação errada: a diretoria mudou de ideia' }, tx, AGORA);
    pedidos.length = 0;
    const depois = await consulta();
    assert.equal(depois.ok, true);
    assert.doesNotMatch(texto(pedidos), /prioridade: Aurora/);
    assert.doesNotMatch(depois.answer, /prioridade: Aurora|Aurora/);
    assert.equal(depois.groundingStatus, 'INSUFFICIENT_SOURCES', 'sem a memória não há fonte');
    // Substituída (corrigida): só a versão nova entra.
    const v1 = (await memoria.save(dono(c), dados(run, { value: { decision: 'versão um' } }), tx, AGORA)).memory;
    await memoria.correct(dono(c), v1.id, { value: { decision: 'versão dois' } }, tx, AGORA);
    pedidos.length = 0;
    await H.rodar(c, `Qual imóvel priorizar? ${pergunta}`, { taskType: 'priorizar_imoveis', subject: { type: 'Property', id: v1.subjectId } });
    assert.match(texto(pedidos), /versão dois/);
    assert.doesNotMatch(texto(pedidos), /versão um/);
  });
});

test('m9d020_memoria_nao_entra_sem_o_guarda_de_campos_ou_sem_lista_branca', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const sem = await H.cenario(tenantA, tx, { deps: { registry, aiAccess: null } }); // sem aiAccess: o ContextBuilder não monta contexto (falha fechada)
    const run = await origemRun(tenantA, tx);
    const m = (await memoria.save(dono(sem), dados(run, { value: { decision: 'prioridade: Aurora' } }), tx, AGORA)).memory;
    const r = await H.rodar(sem, `Qual imóvel priorizar? ${pergunta}`, { taskType: 'priorizar_imoveis', subject: { type: 'Property', id: m.subjectId } });
    assert.equal(r.ok, true);
    assert.doesNotMatch(texto(pedidos), /prioridade: Aurora/);
    // Tarefa sem os campos de memória na lista branca não leva memória, mesmo com o guarda ligado.
    pedidos.length = 0;
    const com = await H.cenario(tenantA, tx, { deps: { registry, aiAccess: createAiAccess() } });
    await H.rodar(com, `Qual imóvel priorizar? ${pergunta}`, { taskType: 'consulta', subject: { type: 'Property', id: m.subjectId } });
    assert.doesNotMatch(texto(pedidos), /prioridade: Aurora/);
  });
});
