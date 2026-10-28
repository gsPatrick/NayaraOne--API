'use strict';

// M9-D028 — o que a NAY guarda é só resumo redigido (até o limite do parâmetro), nunca o documento nem o prompt completo bruto.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { AI_SETTINGS_SCHEMA } = require('../../../src/features/ai/ai.settings');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const comPerm = (ctx) => ({ ...ctx, permissions: ['ai:use', 'ai:read'] });

test('m9d028_run_sem_documento_completo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA));
    const documento = 'Cláusula do contrato inteiro. '.repeat(3000);
    const { run } = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 't', inputSummary: documento }, tx);
    assert.equal(run.inputSummary.length, 2000, 'padrão: resumo de entrada até 2000 caracteres');
    const fim = await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: documento }, tx);
    assert.equal(fim.outputSummary.length, 2000);
    const regra = await runs.recordRuleRun(ctx, { agentName: 'NAY_TESTE', inputSummary: documento, outputSummary: documento }, tx);
    assert.ok(regra.inputSummary.length <= 2000 && regra.outputSummary.length <= 2000);
    // O limite é parâmetro da empresa.
    await upsertSetting('ia.auditoria.resumo_max_caracteres', 300, ctx, ctx.userId, tx);
    const outro = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 't', inputSummary: documento }, tx);
    assert.equal(outro.run.inputSummary.length, 300);
    // O banco também recusa: nem por SQL direto entra resumo maior que 2000.
    await expectDbError(tx, "INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, input_summary) VALUES (gen_random_uuid(), :g, :c, 'X', repeat('a', 2001))",
      { g: tenantA.groupId, c: tenantA.companyId }, /ai_runs_input_summary_chk/);
    await expectDbError(tx, "INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, output_summary) VALUES (gen_random_uuid(), :g, :c, 'X', repeat('a', 2001))",
      { g: tenantA.groupId, c: tenantA.companyId }, /ai_runs_output_summary_chk/);
  });
});

test('m9d028_prompt_completo_bruto_nunca_guardado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA));
    const { run } = await runs.startRun(ctx, {
      agentName: 'NAY_TESTE', purpose: 't', inputSummary: 'resumo curto', prompt: 'PROMPT-BRUTO-COMPLETO', rawPrompt: 'PROMPT-BRUTO-COMPLETO', messages: [{ content: 'PROMPT-BRUTO-COMPLETO' }],
    }, tx);
    await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: 'ok', rawResponse: 'RESPOSTA-BRUTA-DO-PROVIDER', providerResponse: { text: 'RESPOSTA-BRUTA-DO-PROVIDER' } }, tx);
    await runs.recordRuleRun(ctx, {
      agentName: 'NAY_TESTE', inputSummary: 'resumo', outputSummary: 'ok',
      toolCallsJson: { prompt: 'PROMPT-BRUTO-COMPLETO', rawResponse: 'RESPOSTA-BRUTA-DO-PROVIDER', embedding: [0.1, 0.2], headers: { a: 'b' }, method: 'RULE_BASED' },
    }, tx);
    const [t] = await q(`SELECT (SELECT string_agg(r::text, ' ') FROM ai.ai_runs r) AS runs, (SELECT coalesce(string_agg(s::text, ' '), '') FROM ai.ai_sources s) AS fontes`, {}, tx);
    for (const marca of ['PROMPT-BRUTO-COMPLETO', 'RESPOSTA-BRUTA-DO-PROVIDER']) {
      assert.ok(!t.runs.includes(marca) && !t.fontes.includes(marca), marca);
    }
    const [guardado] = await q("SELECT tool_calls_json FROM ai.ai_runs WHERE agent_name = 'NAY_TESTE' AND tool_calls_json IS NOT NULL ORDER BY created_at DESC LIMIT 1", {}, tx);
    assert.deepEqual(guardado.tool_calls_json, { method: 'RULE_BASED' });
    // Não existe coluna, tabela de conteúdo bruto nem parâmetro que permita guardar o prompt completo.
    const colunas = await q(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name IN ('ai_runs', 'ai_sources', 'ai_recommendations')
         AND column_name ~* '(prompt|raw|full_|embedding|header|messages)'`, {}, tx
    );
    assert.deepEqual(colunas, []);
    const chaves = Object.keys(AI_SETTINGS_SCHEMA).filter((k) => /(guardar|armazenar|salvar|manter).*(prompt|bruto|completo|documento)|(prompt|documento).*(guardar|armazenar|salvar)/i.test(k) && !k.startsWith('ia.memoria.guardar_conversa'));
    assert.deepEqual(chaves, []);
  });
});
