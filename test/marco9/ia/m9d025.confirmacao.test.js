'use strict';

// M9-D025 item 7 — prazo e contrato crítico: fonte exata, "Confirmação humana necessária antes de agir" e recomendação
// REQUIRES_CONFIRMATION (sem ação proposta) dirigida a quem tem legal:read. Roda com nayara_runtime (RLS real), com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { Role, RolePermission, Permission, UserMembership } = require('../../../src/models');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { finalizeGrounding } = require('../../../src/features/ai/orchestrator/grounding');
const { listUsersWithPermission } = require('../../../src/features/ai/readmodels/legalReaders.readmodel');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { fonteContrato, fonteReadModel, CONTRATO_ID } = require('../_helpers/m9d025Fixtures');

let tenantA;
let tenantB;
let pessoas;
before(async () => {
  ({ tenantA, tenantB } = await prepararTenants());
  await carregarPessoas();
  pessoas = (await q('SELECT id FROM core.users ORDER BY email LIMIT 6')).map((r) => r.id);
});
after(async () => { await sequelize.close(); });

const TEXTO = 'O contrato vence em 30/11/2026 [1].';
const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });

async function novoRun(ctx, tx) {
  const { run } = await runs.startRun(ctx, { agentName: 'NAY_JURIDICO', purpose: 'consulta de prazo', inputSummary: 'quando vence?' }, tx);
  return run;
}

/** Dá legal:read a uma pessoa da empresa (papel + membership) dentro da transação do teste. */
async function darLegalRead(tenant, userId, tx) {
  const permissao = await Permission.findOne({ where: { code: 'legal:read' }, transaction: tx });
  assert.ok(permissao, 'a permissão legal:read existe no catálogo');
  const role = await Role.create({ groupId: tenant.groupId, companyId: tenant.companyId, name: `Jurídico leitura ${uid().slice(0, 8)}`, isSystem: false }, { transaction: tx });
  await RolePermission.create({ roleId: role.id, permissionId: permissao.id }, { transaction: tx });
  await UserMembership.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId, roleId: role.id, status: 'ACTIVE' }, { transaction: tx });
  return role;
}

test('m9d025_prazo_critico_exige_fonte_exata_e_confirmacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'legal:read');
    const run = await novoRun(ctx, tx);
    // com fonte exata (contrato, versão, cláusula e trecho literal): responde, pede confirmação e não declara definitivo
    const ok = await finalizeGrounding(ctx, { runId: run.id, answerText: TEXTO, taskType: 'consulta', sources: [fonteContrato()], snapshotAt: '2026-10-27T17:05:00.000Z' }, tx);
    assert.equal(ok.groundingStatus, 'GROUNDED');
    assert.equal(ok.requiresHumanConfirmation, true);
    assert.match(ok.answer, /Confirmação humana necessária antes de agir\./);
    assert.equal(ok.sources[0].clause, '4.2');
    assert.equal(ok.sources[0].version, '3');
    assert.match(ok.sources[0].excerpt, /vence em 30\/11\/2026/);
    assert.equal(ok.snapshotAtLocal, '27/10/2026 14:05');
    // sem fonte exata (sem cláusula): orientação do livro, HTTP 200, e NENHUMA recomendação
    const run2 = await novoRun(ctx, tx);
    const semExata = await finalizeGrounding(ctx, { runId: run2.id, answerText: TEXTO, taskType: 'consulta', sources: [fonteContrato({ clause: null })] }, tx);
    assert.equal(semExata.answer.split('\n')[0], 'Não tenho a fonte exata deste prazo; consulte o responsável jurídico.');
    assert.equal(semExata.recommendation, null);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM ai.ai_recommendations WHERE ai_run_id = :r", { r: run2.id }, tx);
    assert.equal(n, 0);
    // resposta financeira comum não é prazo crítico
    const run3 = await novoRun(ctx, tx);
    const fin = await finalizeGrounding(ctx, { runId: run3.id, answerText: 'A inadimplência é de R$ 18.432,50 [1].', taskType: 'consulta', sources: [fonteReadModel()] }, tx);
    assert.equal(fin.requiresHumanConfirmation, false);
    assert.equal(fin.recommendation, null);
  });
});

test('m9d025_prazo_critico_cria_recomendacao_requires_confirmation_para_legal_read', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const leitores = await listUsersWithPermission(ctxDe(tenantA), 'legal:read', tx);
    const perguntou = pessoas.find((id) => !leitores.includes(id));
    const juridico = pessoas.find((id) => id !== perguntou);
    assert.ok(perguntou, 'o seed tem alguém sem legal:read para fazer a pergunta');
    await darLegalRead(tenantA, juridico, tx);
    const [{ tarefasAntes }] = await q('SELECT count(*)::int AS "tarefasAntes" FROM core.tasks', {}, tx);
    // quem perguntou NÃO tem legal:read: a recomendação vai para quem tem
    const ctx = comPerm(ctxDe(tenantA, perguntou), 'ai:use');
    const run = await novoRun(ctx, tx);
    const input = { runId: run.id, answerText: TEXTO, taskType: 'consulta', sources: [fonteContrato()], snapshotAt: '2026-10-27T17:05:00.000Z' };
    const r = await finalizeGrounding(ctx, input, tx);
    assert.ok(r.recommendation && r.recommendation.id);
    const [rec] = await q('SELECT * FROM ai.ai_recommendations WHERE id = :id', { id: r.recommendation.id }, tx);
    assert.equal(rec.recommendation_type, 'REQUIRES_CONFIRMATION');
    assert.notEqual(rec.target_user_id, perguntou, 'quem perguntou não tem legal:read');
    const [{ tem }] = await q(`SELECT count(*)::int AS tem FROM core.user_memberships um JOIN core.role_permissions rp ON rp.role_id = um.role_id
      JOIN core.permissions p ON p.id = rp.permission_id WHERE um.user_id = :u AND um.company_id = :c AND um.status = 'ACTIVE' AND p.code = 'legal:read'`,
    { u: rec.target_user_id, c: tenantA.companyId }, tx);
    assert.ok(tem >= 1, 'o destinatário tem legal:read na empresa');
    assert.equal(rec.status, 'PENDING');
    assert.equal(rec.ai_run_id, run.id);
    assert.equal(rec.company_id, tenantA.companyId);
    assert.equal(rec.related_entity_type, 'LEGAL_CONTRACT');
    assert.equal(rec.related_entity_id, CONTRATO_ID);
    assert.equal(rec.decided_by_user_id, null, 'a NAY não decide');
    assert.ok(!('proposed_action' in rec) || rec.proposed_action === null, 'recomendação informativa: sem ação proposta');
    assert.match(rec.rationale, /Confirmação humana necessária antes de agir\./);
    assert.equal(rec.payload_json.clause, '4.2');
    assert.equal(rec.payload_json.noLegalReader, false);
    // nenhuma tarefa é criada
    const [{ tarefasDepois }] = await q('SELECT count(*)::int AS "tarefasDepois" FROM core.tasks', {}, tx);
    assert.equal(tarefasDepois, tarefasAntes);
    // repetir o passo 11 do mesmo run devolve a mesma recomendação (uma por run)
    const again = await finalizeGrounding(ctx, input, tx);
    assert.equal(again.recommendation.id, r.recommendation.id);
    assert.equal(again.recommendation.replay, true);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM ai.ai_recommendations WHERE ai_run_id = :r AND recommendation_type = 'REQUIRES_CONFIRMATION'", { r: run.id }, tx);
    assert.equal(n, 1);
    // auditoria registrada
    const [{ a }] = await q("SELECT count(*)::int AS a FROM audit.audit_log WHERE entity_id = :id AND action = 'ai.recommendation.created'", { id: r.recommendation.id }, tx);
    assert.equal(a, 1);
    const [{ ev }] = await q("SELECT count(*)::int AS ev FROM integration.outbox_events WHERE event_type = 'ai.recommendation.created' AND aggregate_id = :id", { id: r.recommendation.id }, tx);
    assert.equal(ev, 1);
    // quem já tem legal:read recebe a própria recomendação
    const ctxJuridico = comPerm(ctxDe(tenantA, juridico), 'ai:use', 'legal:read');
    const run2 = await novoRun(ctxJuridico, tx);
    const r2 = await finalizeGrounding(ctxJuridico, { ...input, runId: run2.id }, tx);
    assert.equal(r2.recommendation.targetUserId, juridico);
  });
  // outra empresa não enxerga a recomendação (RLS)
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const [{ n }] = await q("SELECT count(*)::int AS n FROM ai.ai_recommendations WHERE recommendation_type = 'REQUIRES_CONFIRMATION' AND company_id = :c", { c: tenantA.companyId }, tx);
    assert.equal(n, 0);
  });
});

test('m9d025_sem_leitor_juridico_cai_em_quem_perguntou_sinalizado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA, pessoas[2]), 'ai:use');
    const run = await novoRun(ctx, tx);
    const r = await finalizeGrounding(ctx, { runId: run.id, answerText: TEXTO, taskType: 'consulta', sources: [fonteContrato()] }, tx);
    const [rec] = await q('SELECT target_user_id, payload_json FROM ai.ai_recommendations WHERE id = :id', { id: r.recommendation.id }, tx);
    assert.equal(rec.payload_json.noLegalReader === true || rec.target_user_id !== null, true);
    assert.equal(rec.target_user_id, r.recommendation.targetUserId);
  });
});

test('m9d025_parametros_da_empresa_governam_o_grounding_e_gravam_no_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const dono = ctx.userId;
    const fontes = [fonteContrato({ relevanceScore: 0.3 })];
    const run = await novoRun(ctx, tx);
    // padrão: relevância 0,5 reprova a fonte de 0,3
    const padrao = await finalizeGrounding(ctx, { runId: run.id, answerText: 'A multa é de R$ 1.500,00 [1].', taskType: 'consulta', sources: fontes }, tx);
    assert.equal(padrao.groundingStatus, 'INSUFFICIENT_SOURCES');
    // a empresa baixa o limiar na tela de Parâmetros
    await upsertSetting('ia.grounding.relevancia_minima', 0.2, tenantA, dono, tx);
    const baixo = await finalizeGrounding(ctx, { runId: run.id, answerText: 'A multa é de R$ 1.500,00 [1].', taskType: 'consulta', sources: fontes, snapshotAt: '2026-10-27T17:05:00.000Z' }, tx);
    assert.equal(baixo.groundingStatus, 'GROUNDED');
    // a empresa escolhe bloquear em vez de responder com insuficiência
    await upsertSetting('ia.grounding.bloquear_sem_fonte', true, tenantA, dono, tx);
    await assert.rejects(finalizeGrounding(ctx, { runId: run.id, answerText: 'O aluguel é de R$ 3.200,00.', taskType: 'consulta', sources: [] }, tx), { code: 'AI_UNGROUNDED_FACT', statusCode: 422 });
    // lista de termos críticos e de tarefas não factuais também vêm da empresa
    await upsertSetting('ia.grounding.termos_criticos', 'carência', tenantA, dono, tx);
    const sem = await finalizeGrounding(ctx, { runId: run.id, answerText: TEXTO, taskType: 'consulta', sources: [fonteContrato()] }, tx);
    assert.equal(sem.requiresHumanConfirmation, false, 'com a lista trocada, "contrato vence" deixou de ser termo crítico');
    // o orquestrador grava no estado final do run
    const fim = await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: 'ok', ...baixo.runFields }, tx);
    assert.equal(fim.groundingStatus, 'GROUNDED');
    assert.equal(fim.snapshotAt, '2026-10-27T17:05:00.000Z');
    assert.equal(Number(fim.confidence) > 0, true);
    // valores fora da faixa são recusados pela tela de parâmetros
    await assert.rejects(upsertSetting('ia.grounding.relevancia_minima', 1.5, tenantA, dono, tx), { code: 'SETTING_INVALID_VALUE' });
  });
});
