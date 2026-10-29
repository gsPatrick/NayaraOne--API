'use strict';

// M9-D015 — o cache seguro ligado ao roteador (cachePort.register) e ao orquestrador: a mesma pergunta elegível sai pelo caminho CACHE sem chamar
// o modelo; outra empresa, outro usuário sem a permissão, tarefa fora da lista, ação e fonte revogada nunca acertam.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { espiaRegistry } = require('../_helpers/iaEspia');
const { fonteIndexada, TEXTO } = require('../_helpers/iaCache');
const { cachePort } = require('../../../src/features/ai/providers');
const H = require('../_helpers/iaOrquestrador');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const POLICY = { capability: 'chat', maxOutputTokens: 800, cacheableTaskTypes: ['resumir_faq'] };
const PERGUNTA = 'Qual o prazo do reembolso? [[RESPOSTA:O reembolso é feito em 7 dias úteis [1].]]';

async function cenario(tx, { ligado = true, policy = POLICY, fonte } = {}) {
  if (ligado) await definirParametro(tenantA, 'ia.cache.habilitado', true, tx);
  const indexada = fonte || await fonteIndexada(tenantA, tx);
  const { registry, pedidos } = espiaRegistry();
  const retrieve = async () => [{ ...indexada, text: TEXTO }];
  const c = await H.cenario(tenantA, tx, { agentOver: { modelPolicy: policy }, deps: { registry, retrieve } });
  return { c, pedidos, indexada };
}
const perguntar = (c, over = {}) => H.rodar(c, PERGUNTA, { taskType: 'resumir_faq', ...over });

test('m9d015_cache_registrado_na_porta_do_roteador', () => {
  require('../../../src/features/ai/orchestrator');
  assert.equal(cachePort.registered, true);
});

test('m9d015_acerto_custo_zero_com_fontes_originais', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, pedidos } = await cenario(tx);
    const primeira = await perguntar(c);
    assert.equal(primeira.ok, true, JSON.stringify(primeira.error));
    assert.equal(primeira.routingPath, 'SMALL_MODEL');
    assert.equal(primeira.cached, false);
    assert.equal(pedidos.length, 1);
    const segunda = await perguntar(c, { idempotencyKey: undefined });
    assert.equal(segunda.ok, true, JSON.stringify(segunda.error));
    assert.equal(segunda.routingPath, 'CACHE');
    assert.equal(segunda.cached, true);
    assert.equal(Number(segunda.cost.amount), 0);
    assert.equal(pedidos.length, 1, 'o modelo não foi chamado de novo');
    assert.equal(segunda.answer, primeira.answer);
    assert.deepEqual(segunda.sources, primeira.sources, 'as fontes originais voltam');
    const run = await H.lerRun(segunda.runId, tx);
    assert.equal(run.routing_path, 'CACHE');
    assert.equal(run.cached, true);
    assert.equal(Number(run.cost_amount), 0);
    assert.equal(run.provider_code, null);
    assert.equal(run.status, 'COMPLETED');
  });
});

test('m9d015_desligado_por_padrao_e_fora_da_lista_nunca_acerta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const desligado = await cenario(tx, { ligado: false });
    await perguntar(desligado.c);
    assert.equal((await perguntar(desligado.c)).routingPath, 'SMALL_MODEL', 'padrão Desligado');
    const ligado = await cenario(tx);
    await perguntar(ligado.c, { taskType: 'resumir_outro' });
    assert.equal((await perguntar(ligado.c, { taskType: 'resumir_outro' })).routingPath, 'SMALL_MODEL', 'tarefa fora de cacheableTaskTypes');
    const vazia = await cenario(tx, { policy: { ...POLICY, cacheableTaskTypes: [] } });
    await perguntar(vazia.c);
    assert.equal((await perguntar(vazia.c)).routingPath, 'SMALL_MODEL', 'lista vazia (padrão)');
  });
});

test('m9d015_outro_usuario_sem_a_mesma_permissao_nao_acerta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, pedidos } = await cenario(tx);
    await perguntar(c);
    const menos = await perguntar(c, { auth: { ...c.auth, permissions: ['ai:use'] } });
    assert.equal(menos.ok, true, JSON.stringify(menos.error));
    assert.equal(menos.routingPath, 'SMALL_MODEL');
    assert.equal(pedidos.length, 2, 'o modelo foi chamado para quem tem menos permissão');
    assert.equal((await perguntar(c)).routingPath, 'CACHE', 'quem tem as permissões originais acerta');
  });
});

test('m9d015_acao_com_tool_nao_e_cacheada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c } = await cenario(tx);
    const texto = `Qual o prazo? ${H.pedirOportunidade(c)} [[RESPOSTA:O reembolso é feito em 7 dias úteis [1].]]`;
    await H.rodar(c, texto, { taskType: 'resumir_faq' });
    const de = await H.rodar(c, texto, { taskType: 'resumir_faq' });
    assert.notEqual(de.routingPath, 'CACHE');
    assert.equal(Number((await q('SELECT count(*)::int AS n FROM ai.cache_entries', {}, tx))[0].n), 0);
  });
});

test('m9d015_fonte_revogada_depois_da_primeira_resposta_invalida_o_acerto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, indexada } = await cenario(tx);
    await perguntar(c);
    assert.equal((await perguntar(c)).routingPath, 'CACHE');
    await q("UPDATE ai.chunks SET status = 'REVOKED' WHERE source_id = :id", { id: indexada.sourceRef }, tx);
    assert.equal((await perguntar(c)).routingPath, 'SMALL_MODEL', 'a entrada foi invalidada');
  });
});
