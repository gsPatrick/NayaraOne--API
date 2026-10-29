'use strict';

// M9-D034 — avaliação do agente (golden verde, D033) e a trava de gravação de `ia.comercial.permitir_propostas`: Ligado só com a versão
// ativa avaliada (PASSED) e homologada por uma pessoa (409 AI_AGENT_NOT_HOMOLOGATED). Serviço em rollback e HTTP real no cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q } = require('../../helpers/aiAgents');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const H = require('../_helpers/iaAvaliacao');
const C = require('../_helpers/iaComercial');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { registerNayComercial } = require('../../../src/features/ai/agents/nay_comercial');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const svc = new AiEvaluationService();
const como = (tenant, userId, ...permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });

test('m9d034_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx);
    const ev = await H.avaliar(svc, como(tenantA, c.ctx.userId, 'ai:evaluate'), tx, { agentCode: C.CODE, suite: 'all' });
    assert.equal(ev.status, 'PASSED', JSON.stringify(ev.metrics));
    const casos = await q("SELECT category, count(*)::int AS n FROM ai.golden_cases WHERE company_id IS NULL AND agent_code = 'NAY_COMERCIAL' GROUP BY category ORDER BY category", {}, tx);
    assert.deepEqual(Object.fromEntries(casos.map((x) => [x.category, x.n])), { GROUNDING: 2, HALLUCINATION: 2, TOOL_SELECTION: 3, PERMISSIONS: 3, COST: 1, LATENCY: 1 });
  });
});

test('m9d034_ligar_permitir_propostas_exige_avaliacao_e_homologacao_servico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    registerNayComercial();
    const sem = await C.cenario(tenantA, tx);
    const chave = 'ia.comercial.permitir_propostas';
    const ctx = sem.ctx;
    // Sem avaliação: 409 e o valor não é gravado.
    await assert.rejects(upsertSetting(chave, true, ctx, ctx.userId, tx), (e) => e.statusCode === 409 && e.code === 'AI_AGENT_NOT_HOMOLOGATED');
    assert.equal((await q("SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = :c AND key = :k", { c: tenantA.companyId, k: chave }, tx))[0].n, 0);
    // Desligar nunca é recusado.
    await upsertSetting(chave, false, ctx, ctx.userId, tx);
    // Avaliação PASSED sem homologação humana: ainda 409.
    const disparador = ctx.userId;
    const ev = await H.avaliar(svc, como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: C.CODE, suite: 'all' });
    assert.equal(ev.status, 'PASSED');
    await assert.rejects(upsertSetting(chave, true, ctx, ctx.userId, tx), (e) => e.code === 'AI_AGENT_NOT_HOMOLOGATED');
    // Homologada por outra pessoa: grava.
    const outra = (await q('SELECT id FROM core.users WHERE id <> :u ORDER BY email LIMIT 1', { u: disparador }, tx))[0].id;
    await svc.homologate(como(tenantA, outra, 'ai:evaluate'), ev.id, { note: 'Piloto comercial aprovado.' }, tx);
    const salvo = await upsertSetting(chave, true, ctx, ctx.userId, tx);
    assert.equal(salvo.value, true);
  });
});
