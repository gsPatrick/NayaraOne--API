'use strict';

// Suíte adversarial da NAY (M9-D042), teste 14 do livro. Dona: M9-D027. Banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const logger = require('../../../../src/utils/logger');
const runs = require('../../../../src/features/ai/orchestrator/runs');
const { buildContext, registerTaskType, unregisterTaskType } = require('../../../../src/features/ai/security');
const { createAiAccess, TAREFA, CAMPOS_TAREFA, fonte, semPii } = require('../../_helpers/iaPrivacidade');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); registerTaskType(TAREFA, CAMPOS_TAREFA); });
after(async () => { unregisterTaskType(TAREFA); await F.sequelize.close(); });

const PLANTADOS = ['123.456.789-09', 'maria.secreta@exemplo.com.br', 'SENHA-MUITO-SECRETA-77', ['Bear', 'er abcdefghijklmnop1234567890'].join('')]; // montado em tempo de execução: nenhum segredo de fixture no arquivo
const TEXTO = `Cliente CPF ${PLANTADOS[0]}, e-mail ${PLANTADOS[1]}, senha: ${PLANTADOS[2]}, ${PLANTADOS[3]}`;

test('adv_pii_no_log_redaction', async () => {
  const linhasDeLog = [];
  const soltar = logger.addLogTap((linha) => linhasDeLog.push(linha));
  try {
    await F.withRollbackTenantTransaction(tenantA, async (tx) => {
      const ctx = { ...F.ctxDe(tenantA), permissions: ['ai:use', 'ai:audit'] };
      const { run } = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 'teste', inputSummary: TEXTO }, tx);
      await runs.recordSource(ctx, run.id, { sourceType: 'DOCUMENT_CHUNK', sourceRef: 'doc:1', excerpt: `Trecho: ${TEXTO}` }, tx);
      const contexto = await buildContext(ctx, {
        runId: run.id, taskType: TAREFA, instruction: TEXTO, purpose: 'cobrança', provider: { external: true },
        sources: [fonte(tenantA, { id: 'cli', key: 'cliente', fields: { nome: 'Maria Secreta', cpf: PLANTADOS[0] } })],
      }, tx, { aiAccess: createAiAccess() });
      assert.ok(semPii(JSON.stringify(contexto.messages)), 'o payload do provider não tem PII');
      await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: `Resposta: ${TEXTO}` }, tx);
      const linhas = [
        ...(await F.q('SELECT to_jsonb(r)::text AS t FROM ai.ai_runs r WHERE id = :id', { id: run.id }, tx)),
        ...(await F.q('SELECT to_jsonb(s)::text AS t FROM ai.ai_sources s WHERE ai_run_id = :id', { id: run.id }, tx)),
        ...(await F.q('SELECT to_jsonb(a)::text AS t FROM audit.audit_log a WHERE entity_id = :id', { id: run.id }, tx)),
      ];
      assert.ok(linhas.length >= 3, 'varredura com linhas');
      for (const { t } of linhas) for (const valor of PLANTADOS) assert.ok(!t.includes(valor), `"${valor}" apareceu em claro`);
      const [runRow] = await F.q('SELECT input_summary, output_summary FROM ai.ai_runs WHERE id = :id', { id: run.id }, tx);
      assert.match(runRow.input_summary, /\[REDIGIDO:cpf\]/);
      assert.match(runRow.output_summary, /\[REDIGIDO:email\]/);
    });
  } finally { soltar(); }
  assert.ok(linhasDeLog.some((l) => l.includes('ai.context.privacy_decision')));
  for (const linha of linhasDeLog) for (const valor of PLANTADOS) assert.ok(!linha.includes(valor), `"${valor}" apareceu no log`);
});
