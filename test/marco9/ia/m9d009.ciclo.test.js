'use strict';

// M9-D009 — ciclo da memória: corrigir gera versão e preserva o histórico, invalidada não reaparece (adversarial do livro),
// expirada não é recuperada, escopo USER só do dono, empresa B não lê e o contexto do run recebe só o que vale.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { buildContext, registerTaskType, unregisterTaskType } = require('../../../src/features/ai/security');
const { MEMORY_CONTEXT_FIELDS } = require('../../../src/features/ai/memory');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { createSandboxProvider, createAiAccess } = require('../_helpers/iaPrivacidade');
const { memoria, comPerm, dados, origemRun, rejeita } = require('../_helpers/iaMemoria');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); registerTaskType('priorizar_imoveis', { fields: [...MEMORY_CONTEXT_FIELDS] }); });
after(async () => { unregisterTaskType('priorizar_imoveis'); await sequelize.close(); });

const ana = () => comPerm(ctxDe(tenantA), 'ai:use');
const admin = () => comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');
const DIA = 24 * 3600 * 1000;
const linhas = (ids, tx) => q('SELECT id, status, version, supersedes_id, invalidated_by, invalidation_reason FROM ai.memories WHERE id IN (:ids) ORDER BY version', { ids }, tx);

test('m9d009_corrigir_gera_versao_e_preserva_historico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const dono = ana();
    const v1 = (await memoria.save(dono, dados(run), tx)).memory;
    assert.equal(v1.version, 1); assert.equal(v1.status, 'ACTIVE'); assert.equal(v1.supersedesId, null);
    const out = await memoria.correct(dono, v1.id, { value: { decision: 'Priorizar o Edifício Boa Vista' } }, tx);
    const v2 = out.memory;
    assert.equal(v2.version, 2); assert.equal(v2.supersedesId, v1.id); assert.equal(v2.status, 'ACTIVE');
    assert.equal(v2.memoryType, 'DECISION'); assert.equal(v2.scope, 'COMPANY');
    const hist = await linhas([v1.id, v2.id], tx);
    assert.deepEqual(hist.map((h) => [h.version, h.status]), [[1, 'SUPERSEDED'], [2, 'ACTIVE']]);
    // Só a vigente entra no contexto; a antiga continua no histórico.
    const vistas = await memoria.recall(dono, { subject: { type: 'Property', id: 'aurora' } }, tx);
    assert.deepEqual(vistas.map((m) => m.id), [v2.id]);
    // Corrigir a já substituída é recusado.
    await rejeita(memoria.correct(dono, v1.id, { value: { decision: 'outra' } }, tx), 409, 'AI_MEMORY_NOT_ACTIVE');
    await rejeita(memoria.correct(dono, v2.id, {}, tx), 400, 'AI_MEMORY_INVALID');
    // A trilha de auditoria registra as duas gravações, sem o valor.
    const aud = await q("SELECT action, after_json FROM audit.audit_log WHERE entity_type = 'AiMemory' AND entity_id IN (:a, :b) ORDER BY action", { a: v1.id, b: v2.id }, tx);
    assert.deepEqual(aud.map((a) => a.action), ['ai.memory.corrected', 'ai.memory.created']);
    assert.ok(!JSON.stringify(aud).includes('Boa Vista'));
  });
});

async function memoriaPorContexto(ctx, tx, extra = {}) {
  const fontes = await memoria.recallAsSources(ctx, { subject: { type: 'Property', id: 'aurora' } }, tx);
  const out = await buildContext(ctx, {
    runId: null, taskType: 'priorizar_imoveis', instruction: 'Qual imóvel priorizar?', purpose: 'planejamento', provider: createSandboxProvider().descriptor,
    sources: fontes, agentContext: { agentCode: 'NAY_COMERCIAL' }, ...extra,
  }, tx, { aiAccess: createAiAccess() });
  return { fontes, texto: JSON.stringify(out.messages) };
}

test('adv_memoria_invalidada_nao_reaparece', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const dono = ana();
    const m = (await memoria.save(dono, dados(run, { value: { decision: 'prioridade: Aurora' } }), tx)).memory;
    const antes = await memoriaPorContexto(dono, tx);
    assert.equal(antes.fontes.length, 1);
    assert.match(antes.texto, /prioridade: Aurora/, 'vigente entra no contexto do run');
    assert.match(antes.texto, new RegExp(m.sourceId), 'com a origem para citação');
    // Invalida (motivo obrigatório) e roda de novo: a memória sai do contexto e da resposta.
    await rejeita(memoria.invalidate(dono, m.id, {}, tx), 400, 'AI_MEMORY_INVALID');
    const inv = await memoria.invalidate(dono, m.id, { reason: 'Informação errada: a diretoria mudou de ideia' }, tx);
    assert.equal(inv.memory.status, 'INVALIDATED'); assert.equal(inv.memory.invalidatedBy, dono.userId); assert.ok(inv.memory.invalidatedAt);
    const depois = await memoriaPorContexto(dono, tx);
    assert.equal(depois.fontes.length, 0);
    assert.ok(!depois.texto.includes('prioridade: Aurora'));
    assert.deepEqual(await memoria.recall(dono, {}, tx), []);
    // A linha continua no histórico, com quem invalidou e por quê.
    const [linha] = await linhas([m.id], tx);
    assert.equal(linha.status, 'INVALIDATED'); assert.match(linha.invalidation_reason, /diretoria mudou/);
    const hist = await memoria.list(dono, { status: 'INVALIDATED' }, tx);
    assert.deepEqual(hist.items.map((i) => i.id), [m.id]);
    // Repetir a invalidação devolve a mesma linha; corrigir invalidada é recusado.
    assert.equal((await memoria.invalidate(dono, m.id, { reason: 'repetida outra vez' }, tx)).replayed, true);
    await rejeita(memoria.correct(dono, m.id, { value: { decision: 'x' } }, tx), 409, 'AI_MEMORY_NOT_ACTIVE');
  });
});

test('m9d009_expirada_nao_e_recuperada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const dono = ana();
    const t0 = new Date('2026-10-27T12:00:00Z');
    const curta = (await memoria.save(dono, dados(run, { expiresAt: new Date(t0.getTime() + DIA).toISOString() }), tx, { now: t0 })).memory;
    const longa = (await memoria.save(dono, dados(run, { subjectId: 'outra' }), tx, { now: t0 })).memory;
    const aurora = { subject: { type: 'Property', id: 'aurora' } };
    assert.equal((await memoria.recall(dono, aurora, tx, { now: t0 })).length, 1);
    // Depois do prazo, a leitura já ignora a vencida (mesmo antes do job).
    const t1 = new Date(t0.getTime() + 2 * DIA);
    assert.equal((await memoria.recall(dono, aurora, tx, { now: t1 })).length, 0);
    assert.equal((await memoria.recall(dono, { subject: { type: 'Property', id: 'outra' } }, tx, { now: t1 })).length, 1);
    // O job passa a vencida para EXPIRED e não mexe na vigente; EXPIRED não volta (gatilho).
    assert.ok(await memoria.expire(dono, tx, { now: t1 }) >= 1);
    const hist = await linhas([curta.id, longa.id], tx);
    assert.deepEqual(hist.map((h) => h.status).sort(), ['ACTIVE', 'EXPIRED']);
    assert.equal((await memoria.expire(dono, tx, { now: t1 })), 0, 'repetir não muda nada');
    await sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(sequelize.query("UPDATE ai.memories SET status = 'ACTIVE' WHERE id = :id", { replacements: { id: curta.id }, transaction: tx }), /AI_MEMORY_STATE/);
    await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
    await rejeita(memoria.correct(dono, curta.id, { value: { decision: 'x' } }, tx, { now: t1 }), 409, 'AI_MEMORY_NOT_ACTIVE');
    // Valid_from no futuro também não entra.
    const futura = await memoria.save(dono, dados(run, { subjectId: 'futuro', validFrom: new Date(t0.getTime() + DIA).toISOString(), expiresAt: new Date(t0.getTime() + 5 * DIA).toISOString() }), tx, { now: t0 });
    assert.equal((await memoria.recall(dono, { subject: { type: 'Property', id: 'futuro' } }, tx, { now: t0 })).length, 0);
    assert.equal((await memoria.recall(dono, { subject: { type: 'Property', id: 'futuro' } }, tx, { now: new Date(t0.getTime() + 2 * DIA) })).length, 1);
    assert.ok(futura.memory.id);
  });
});

test('m9d009_escopo_user_so_do_dono', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const dono = ana(); const outra = ana();
    const u = (await memoria.save(dono, dados(run, { scope: 'USER', subjectId: 'x' }), tx)).memory;
    const s = (await memoria.save(dono, dados(run, { scope: 'SESSION', subjectId: 'x' }), tx)).memory;
    const c = (await memoria.save(dono, dados(run, { scope: 'COMPANY', subjectId: 'x' }), tx)).memory;
    const g = (await memoria.save(dono, dados(run, { scope: 'AGENT', agentCode: 'NAY_COMERCIAL', subjectId: 'x' }), tx)).memory;
    assert.equal(u.ownerUserId, dono.userId);
    const alvo = { subject: { type: 'Property', id: 'x' } };
    const ids = async (ctx, o = alvo) => (await memoria.recall(ctx, o, tx)).map((m) => m.id).sort();
    assert.deepEqual(await ids(dono, { ...alvo, agent: 'NAY_COMERCIAL' }), [u.id, s.id, c.id, g.id].sort());
    assert.deepEqual(await ids(dono), [u.id, s.id, c.id].sort(), 'AGENT só quando o agente é informado');
    assert.deepEqual(await ids(outra, { ...alvo, agent: 'NAY_COMERCIAL' }), [c.id, g.id].sort(), 'a outra pessoa não vê USER nem SESSION');
    assert.deepEqual(await ids(outra, { ...alvo, agent: 'OUTRO' }), [c.id]);
    // Nem por leitura direta nem para invalidar: 404 sem revelar que existe, mesmo com ai:admin; só quem audita enxerga.
    await rejeita(memoria.get(outra, u.id, tx), 404, 'AI_MEMORY_NOT_FOUND');
    await rejeita(memoria.invalidate(admin(), u.id, { reason: 'tentativa de outro' }, tx), 404, 'AI_MEMORY_NOT_FOUND');
    assert.equal((await memoria.get(comPerm(ctxDe(tenantA), 'ai:audit'), u.id, tx)).id, u.id);
    // Escopo AGENT sem agente e USER de outra pessoa sem ai:admin.
    await rejeita(memoria.save(dono, dados(run, { scope: 'AGENT' }), tx), 400, 'AI_MEMORY_INVALID');
    await rejeita(memoria.save(dono, dados(run, { scope: 'USER', ownerUserId: outra.userId }), tx), 403, 'PERMISSION_DENIED');
    assert.equal((await memoria.save(admin(), dados(run, { scope: 'USER', ownerUserId: outra.userId }), tx)).memory.ownerUserId, outra.userId);
  });
});

test('m9d009_empresa_b_nao_le', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const m = (await memoria.save(ana(), dados(run), tx)).memory;
    const ctxB = comPerm({ groupId: tenantB.groupId, companyId: tenantB.companyId, userId: ctxDe(tenantA).userId }, 'ai:use', 'ai:admin', 'ai:audit');
    // Contexto de B apontando para a linha de A, na transação de A: o filtro por empresa esconde a linha.
    await rejeita(memoria.get(ctxB, m.id, tx), 404, 'AI_MEMORY_NOT_FOUND');
    assert.deepEqual(await memoria.recall(ctxB, {}, tx), []);
    assert.deepEqual((await memoria.list(ctxB, { status: 'ACTIVE' }, tx)).items, []);
    // O banco também esconde: na transação de B a linha de A não existe (RLS).
    const dentro = await q('SELECT count(*)::int AS n FROM ai.memories WHERE id = :id', { id: m.id }, tx);
    assert.equal(dentro[0].n, 1);
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const [{ n }] = await q('SELECT count(*)::int AS n FROM ai.memories', {}, tx);
    assert.equal(n, 0, 'a empresa B não enxerga nenhuma memória da A');
  });
});

test('m9d009_parametros_sao_lidos_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const ctx = ana();
    for (let i = 0; i < 4; i += 1) await memoria.save(ctx, dados(run, { subjectId: 'lote', value: { decision: `d${i}` } }), tx);
    const alvo = { subject: { type: 'Property', id: 'lote' } };
    assert.equal((await memoria.recall(ctx, alvo, tx)).length, 4);
    await upsertSetting('ia.memoria.max_itens_contexto', 2, tenantA, ctx.userId, tx);
    assert.equal((await memoria.recall(ctx, alvo, tx)).length, 2);
    assert.equal((await memoria.recall(ctx, { ...alvo, limit: 1 }, tx)).length, 1);
  });
});
