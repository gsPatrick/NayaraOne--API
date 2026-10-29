'use strict';

// M9-D024 — vigência: expirada e de início posterior nunca entram, o fuso é America/Sao_Paulo e o job diário marca as vencidas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const knowledge = require('../../../src/features/ai/knowledge');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { runAiSourceExpiryJob } = require('../../../src/engines/jobs/aiSourceExpiryJob');
const { vigencia, expireSources } = require('../../../src/features/ai/retrieval');
const { RAG, DIA, depoisDe, resposta, trecho, registro, H } = require('../_helpers/iaVigencia');
const { servico, ctxDe, comPerm, q, uid, carregarPessoas } = require('../_helpers/ragEnv');
const { semear } = require('../_helpers/ragSeed');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const PERGUNTA = 'qual o prazo de entrega da obra Aurora?';
const TEXTO = 'Obra Aurora: o prazo de entrega é de 90 dias.';
const ator = () => comPerm(ctxDe(tenantA), 'ai:use');

test('m9d024_fonte_expirada_nao_entra', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const velha = await trecho(tenantA, tx, TEXTO, { effectiveFrom: depoisDe(-40), effectiveUntil: depoisDe(-1) });
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O prazo de entrega é de 90 dias [1].')}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'INSUFFICIENT_SOURCES');
    assert.deepEqual(await registro(res.runId, tx), [{ ref: velha.sourceId, versao: '1', usada: false, estado: 'EXPIRADA' }]);
    // O fim da vigência é exclusivo: vence exatamente em `effectiveUntil`.
    const vigente = await trecho(tenantA, tx, TEXTO, { effectiveFrom: depoisDe(-40), effectiveUntil: depoisDe(2) });
    const ok = await H.rodar(c, `${PERGUNTA} de novo ${resposta('O prazo de entrega é de 90 dias [1].')}`);
    assert.equal(ok.groundingStatus, 'GROUNDED');
    assert.ok((await registro(ok.runId, tx)).some((l) => l.ref === vigente.sourceId && l.usada && l.estado === 'VIGENTE'));
  });
});

test('m9d024_fonte_com_inicio_posterior_nao_entra', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const futura = await trecho(tenantA, tx, TEXTO, { effectiveFrom: depoisDe(3) });
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O prazo de entrega é de 90 dias [1].')}`);
    assert.equal(res.groundingStatus, 'INSUFFICIENT_SOURCES');
    assert.equal(res.sources.length, 0);
    assert.deepEqual(await registro(res.runId, tx), [{ ref: futura.sourceId, versao: '1', usada: false, estado: 'NAO_INICIADA' }]);
  });
});

test('m9d024_vigencia_em_america_sao_paulo', async () => {
  // Fim em 26/10/2026 23:59:59 de São Paulo (= 27/10 02:59:59Z): às 00:00:01 de 27/10 em São Paulo já venceu; às 23:00 de 26/10 ainda vale.
  const chunk = { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T03:00:00Z'), effectiveUntil: new Date('2026-10-27T02:59:59Z') };
  assert.equal(vigencia.statusAt(chunk, new Date('2026-10-27T03:00:01Z')), 'EXPIRADA');
  assert.equal(vigencia.statusAt(chunk, new Date('2026-10-27T02:00:00Z')), 'VIGENTE');
  assert.equal(vigencia.statusAt({ ...chunk, effectiveUntil: new Date('2026-10-27T03:00:00Z') }, new Date('2026-10-27T03:00:00Z')), 'EXPIRADA', 'o fim é exclusivo');
  // Data sem hora vale no dia de São Paulo: começa à 00:00 do dia e o último dia vale inteiro.
  assert.equal(vigencia.bound('2026-10-26', 'FROM').toISOString(), '2026-10-26T03:00:00.000Z');
  assert.equal(vigencia.bound('2026-10-26', 'UNTIL').toISOString(), '2026-10-27T03:00:00.000Z');
  assert.equal(vigencia.dayOf(new Date('2026-10-27T02:00:00Z')), '2026-10-26', 'duas da manhã em UTC ainda é o dia anterior em São Paulo');
  const dia = { status: 'ACTIVE', effectiveFrom: '2026-10-20', effectiveUntil: '2026-10-26' };
  assert.equal(vigencia.statusAt(dia, new Date('2026-10-27T02:30:00Z')), 'VIGENTE', 'às 23:30 de 26/10 em São Paulo o último dia ainda vale');
  assert.equal(vigencia.statusAt(dia, new Date('2026-10-27T03:00:00Z')), 'EXPIRADA');
  assert.equal(vigencia.statusAt(dia, new Date('2026-10-20T02:59:00Z')), 'NAO_INICIADA');
  for (const status of ['REVOKED', 'SUPERSEDED', 'EXPIRED']) assert.notEqual(vigencia.statusAt({ ...chunk, status }, new Date('2026-06-01T12:00:00Z')), 'VIGENTE');
  // Pela busca, com o relógio de teste: o mesmo trecho vale às 23:00 de 26/10 e não vale à 00:00:01 de 27/10 (São Paulo).
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semear(tenantA, tx, { texto: TEXTO, effectiveFrom: new Date('2026-01-01T03:00:00Z'), effectiveUntil: new Date('2026-10-27T02:59:59Z') });
    assert.equal((await servico.search(ator(), PERGUNTA, { now: new Date('2026-10-27T02:00:00Z') }, tx)).items.length, 1);
    const depois = await servico.search(ator(), PERGUNTA, { now: new Date('2026-10-27T03:00:01Z') }, tx);
    assert.equal(depois.insufficient, true);
  });
});

test('m9d024_job_marca_expiradas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const dono = comPerm(ctxDe(tenantA), 'ai:admin');
    const entrada = await knowledge.createEntry(dono, { factKey: `politica.${uid().slice(0, 8)}`, subjectType: 'politica', title: 'Prazo', value: { regra: 'Prazo de entrega de 90 dias' }, classification: 'INTERNAL', validUntil: depoisDe(2).toISOString() }, tx);
    await knowledge.homologate(comPerm(ctxDe(tenantA), 'ai:admin'), entrada.id, tx);
    const link = await semear(tenantA, tx, { texto: TEXTO, sourceType: 'URL', effectiveUntil: depoisDe(3) });
    const eterno = await semear(tenantA, tx, { texto: TEXTO, sourceType: 'URL' });
    await q("UPDATE ai.chunks SET status = 'ACTIVE' WHERE source_id = :id", { id: entrada.id }, tx);
    const estado = async () => ({
      entrada: (await q('SELECT status, is_active FROM ai.knowledge_entries WHERE id = :id', { id: entrada.id }, tx))[0],
      link: (await q('SELECT status FROM ai.chunks WHERE id = :id', { id: link.id }, tx))[0].status,
      eterno: (await q('SELECT status FROM ai.chunks WHERE id = :id', { id: eterno.id }, tx))[0].status,
    });
    assert.deepEqual(await expireSources(dono, tx, { now: new Date() }), { knowledge: 0, chunks: 0 }, 'nada venceu ainda');
    const em4dias = new Date(Date.now() + 4 * DIA);
    const r = await expireSources(dono, tx, { now: em4dias });
    assert.equal(r.knowledge, 1); assert.ok(r.chunks >= 1);
    assert.deepEqual(await estado(), { entrada: { status: 'EXPIRED', is_active: false }, link: 'EXPIRED', eterno: 'ACTIVE' });
    assert.deepEqual(await expireSources(dono, tx, { now: em4dias }), { knowledge: 0, chunks: 0 }, 'repetir não muda nada');
    const trilha = await q("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'ai.knowledge.expired' AND entity_id = :id", { id: entrada.id }, tx);
    assert.equal(trilha[0].n, 1, 'a expiração fica na auditoria');
  });
});

test('m9d024_job_diario_respeita_o_intervalo_e_o_modulo_exporta_a_passada', async () => {
  assert.equal(typeof runAiSourceExpiryJob, 'function');
  const resumo = await runAiSourceExpiryJob({ now: new Date(), force: true, companyIds: [tenantA.companyId] });
  assert.equal(resumo.errors, 0);
  assert.equal(resumo.companies, 1);
  const segunda = await runAiSourceExpiryJob({ now: new Date(), companyIds: [tenantA.companyId] });
  assert.equal(segunda.companies, 0, 'dentro do intervalo `ia.rag.vigencia.intervalo_horas` a empresa não roda de novo');
});
