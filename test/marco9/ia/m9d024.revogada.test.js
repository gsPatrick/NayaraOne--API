'use strict';

// M9-D024 — fonte revogada, substituída ou de versão anterior nunca vale como resposta; fica no run como não usada, com o estado dela.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const chunksRepo = require('../../../src/features/ai/retrieval/chunks.repository');
const { RAG, resposta, trecho, registro, H } = require('../_helpers/iaVigencia');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERGUNTA = 'qual o desconto máximo da política de desconto?';
const INSUFICIENTE = 'Não tenho informações suficientes nas fontes autorizadas para responder isso com segurança.';

test('adv_fonte_revogada_nao_usada_como_vigente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const v1 = await trecho(tenantA, tx, 'Política de desconto versão 1: o desconto máximo é de 5%.', { status: 'REVOKED' });
    const v2 = await trecho(tenantA, tx, 'Política de desconto versão 2: o desconto máximo é de 7%.', { version: 2 });
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O desconto máximo é de 7% [1].')}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.match(res.answer, /7%/);
    assert.doesNotMatch(res.answer, /5%/);
    assert.equal(res.sources.length, 1, 'só a vigente é citada');
    const linhas = await registro(res.runId, tx);
    assert.deepEqual(linhas.find((l) => l.ref === v2.sourceId), { ref: v2.sourceId, versao: '2', usada: true, estado: 'VIGENTE' });
    assert.deepEqual(linhas.find((l) => l.ref === v1.sourceId), { ref: v1.sourceId, versao: '1', usada: false, estado: 'REVOGADA' }, 'a revogada fica registrada como não usada');
  });
});

test('m9d024_fonte_revogada_nao_grounding', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const so = await trecho(tenantA, tx, 'Política de desconto versão 1: o desconto máximo é de 5%.', { status: 'REVOKED' });
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O desconto máximo é de 5% [1].')}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'INSUFFICIENT_SOURCES', 'só há fonte revogada: vale a insuficiência da D025');
    assert.ok(res.answer.startsWith(INSUFICIENTE));
    assert.doesNotMatch(res.answer, /5%/);
    assert.equal(res.sources.length, 0);
    assert.deepEqual(await registro(res.runId, tx), [{ ref: so.sourceId, versao: '1', usada: false, estado: 'REVOGADA' }]);
  });
});

test('m9d024_nova_versao_da_mesma_origem_nao_e_conflito', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const v1 = await trecho(tenantA, tx, 'Política de desconto: o desconto máximo é de 5%.\nFato: desconto_maximo = 5%', { version: 1 });
    await chunksRepo.supersedeOlder(c.ctx, 'URL', v1.sourceId, 2, tx); // o que o pipeline faz ao gravar a versão 2 da MESMA origem
    await trecho(tenantA, tx, 'Política de desconto: o desconto máximo é de 7%.\nFato: desconto_maximo = 7%', { version: 2, sourceId: v1.sourceId });
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O desconto máximo é de 7% [1].')}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED', 'a versão mais nova substitui a anterior: não é divergência');
    assert.doesNotMatch(res.answer, /divergem/);
    assert.match(res.answer, /7%/);
    const linhas = await registro(res.runId, tx);
    assert.deepEqual(linhas.map((l) => [l.versao, l.usada, l.estado]).sort(), [['1', false, 'SUBSTITUIDA'], ['2', true, 'VIGENTE']]);
  });
});

test('m9d024_registro_de_nao_vigentes_respeita_o_limite_da_empresa', async () => {
  const { upsertSetting } = require('../../../src/features/settings/settings.service');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    await trecho(tenantA, tx, 'Política de desconto versão 1: o desconto máximo é de 5%.', { status: 'REVOKED' });
    await trecho(tenantA, tx, 'Política de desconto versão 0: o desconto máximo é de 3%.', { status: 'REVOKED' });
    await trecho(tenantA, tx, 'Política de desconto versão 2: o desconto máximo é de 7%.', { version: 2 });
    await upsertSetting('ia.rag.nao_vigentes_registrar_max', 1, c.ctx, c.ctx.userId, tx);
    const um = await H.rodar(c, `${PERGUNTA} ${resposta('O desconto máximo é de 7% [1].')}`);
    assert.equal((await registro(um.runId, tx)).filter((l) => !l.usada).length, 1, 'registra no máximo o limite');
    await upsertSetting('ia.rag.nao_vigentes_registrar_max', 0, c.ctx, c.ctx.userId, tx);
    const zero = await H.rodar(c, `${PERGUNTA} de novo ${resposta('O desconto máximo é de 7% [1].')}`);
    assert.equal((await registro(zero.runId, tx)).filter((l) => !l.usada).length, 0, '0 desliga o registro');
  });
});
