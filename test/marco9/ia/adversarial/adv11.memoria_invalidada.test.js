'use strict';

// Suíte adversarial da NAY (M9-D042), teste 11 do livro. Dona: M9-D009. Provider sandbox, banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const { registerTaskType, unregisterTaskType } = require('../../../../src/features/ai/security');
const { MEMORY_CONTEXT_FIELDS } = require('../../../../src/features/ai/memory');
const { memoria, dados, origemRun, comPerm } = require('../../_helpers/iaMemoria');
const { createAiAccess } = require('../../_helpers/iaPrivacidade');
const { espiaRegistry } = require('../../_helpers/iaEspia');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); registerTaskType('priorizar_imoveis', { fields: [...MEMORY_CONTEXT_FIELDS] }); });
after(async () => { unregisterTaskType('priorizar_imoveis'); await F.sequelize.close(); });

const PERGUNTA = 'Qual imóvel priorizar? [[RESPOSTA:Priorizar o imóvel indicado pela diretoria [1].]]';
const AGORA = { now: new Date(F.H.FIXO()) };

test('adv_memoria_invalidada_nao_reaparece', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await F.H.cenario(tenantA, tx, { deps: { registry, aiAccess: createAiAccess() } });
    const dono = comPerm(c.ctx, 'ai:use');
    const run = await origemRun(tenantA, tx);
    const salva = (await memoria.save(dono, dados(run, { value: { decision: 'prioridade: Aurora' } }), tx, AGORA)).memory;
    const consulta = () => F.H.rodar(c, PERGUNTA, { taskType: 'priorizar_imoveis', subject: { type: 'Property', id: salva.subjectId } });
    const noContexto = () => JSON.stringify(pedidos.map((p) => p.messages));
    assert.equal((await consulta()).groundingStatus, 'GROUNDED');
    assert.match(noContexto(), /prioridade: Aurora/, 'vigente entra no contexto');
    // Invalidada: fora do contexto e da resposta; o histórico continua.
    await memoria.invalidate(dono, salva.id, { reason: 'Informação errada: a diretoria mudou de ideia' }, tx, AGORA);
    pedidos.length = 0;
    const depois = await consulta();
    assert.doesNotMatch(noContexto(), /prioridade: Aurora/);
    assert.doesNotMatch(depois.answer, /Aurora/);
    assert.equal(depois.groundingStatus, 'INSUFFICIENT_SOURCES');
    const [linha] = await F.q('SELECT status, invalidation_reason FROM ai.memories WHERE id = :id', { id: salva.id }, tx);
    assert.equal(linha.status, 'INVALIDATED');
    assert.match(linha.invalidation_reason, /diretoria mudou/);
    assert.deepEqual((await memoria.list(dono, { status: 'INVALIDATED' }, tx)).items.map((i) => i.id), [salva.id], 'o histórico mantém a memória invalidada');
  });
});
