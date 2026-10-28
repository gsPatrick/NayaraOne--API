'use strict';

// Marco 9, M9-D027 — teste adversarial do livro "PII no log -> redaction": um run completo (resumo de entrada, fonte, contexto,
// resumo de saída) com dado pessoal e segredo plantados; depois varre log da aplicação, auditoria, ai_runs e ai_sources.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const logger = require('../../../src/utils/logger');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { buildContext, registerTaskType, unregisterTaskType } = require('../../../src/features/ai/security');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiAgents');
const { createAiAccess, TAREFA, CAMPOS_TAREFA, fonte, semPii } = require('../_helpers/iaPrivacidade');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); registerTaskType(TAREFA, CAMPOS_TAREFA); });
after(async () => { unregisterTaskType(TAREFA); await sequelize.close(); });

const PLANTADOS = ['123.456.789-09', '11.222.333/0001-81', '(11) 91234-5678', 'maria.secreta@exemplo.com.br', 'SENHA-MUITO-SECRETA-77', '4111 1111 1111 1111'];
const TEXTO = `Cliente CPF ${PLANTADOS[0]}, CNPJ ${PLANTADOS[1]}, tel ${PLANTADOS[2]}, e-mail ${PLANTADOS[3]}, senha: ${PLANTADOS[4]}, cartão ${PLANTADOS[5]}`;

test('adv_pii_no_log_redaction', async () => {
  const linhasDeLog = [];
  const soltar = logger.addLogTap((linha) => linhasDeLog.push(linha));
  try {
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      const ctx = { ...ctxDe(tenantA), permissions: ['ai:use', 'ai:audit'] };
      const { run } = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 'teste', inputSummary: TEXTO }, tx);
      await runs.recordSource(ctx, run.id, { sourceType: 'DOCUMENT_CHUNK', sourceRef: 'doc:1', excerpt: `Trecho: ${TEXTO}` }, tx);
      const contexto = await buildContext(ctx, {
        runId: run.id, taskType: TAREFA, instruction: TEXTO, purpose: 'cobrança', provider: { external: true },
        sources: [fonte(tenantA, { id: 'cli', key: 'cliente', fields: { nome: 'Maria Secreta', cpf: PLANTADOS[0] } })],
      }, tx, { aiAccess: createAiAccess() });
      assert.ok(semPii(JSON.stringify(contexto.messages)), 'o payload do provider não tem PII');
      await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: `Resposta: ${TEXTO}` }, tx);

      const linhas = [];
      linhas.push(...(await q('SELECT to_jsonb(r)::text AS t FROM ai.ai_runs r WHERE id = :id', { id: run.id }, tx)));
      linhas.push(...(await q('SELECT to_jsonb(s)::text AS t FROM ai.ai_sources s WHERE ai_run_id = :id', { id: run.id }, tx)));
      linhas.push(...(await q('SELECT to_jsonb(a)::text AS t FROM audit.audit_log a WHERE entity_id = :id', { id: run.id }, tx)));
      assert.ok(linhas.length >= 4, `varredura sem linhas (${linhas.length})`);
      for (const { t } of linhas) {
        for (const valor of PLANTADOS) assert.ok(!t.includes(valor), `"${valor}" apareceu em claro: ${t.slice(0, 300)}`);
        assert.ok(semPii(t), `a linha ainda tem padrão de PII: ${t.slice(0, 300)}`);
      }
      const [runRow] = await q('SELECT input_summary, output_summary FROM ai.ai_runs WHERE id = :id', { id: run.id }, tx);
      assert.match(runRow.input_summary, /\[REDIGIDO:cpf\].*\[REDIGIDO:cnpj\].*\[REDIGIDO:telefone\].*\[REDIGIDO:email\].*\[REDIGIDO:senha\].*\[REDIGIDO:cartao\]/);
      assert.match(runRow.output_summary, /\[REDIGIDO:cpf\]/);
    });
  } finally {
    soltar();
  }
  assert.ok(linhasDeLog.some((l) => l.includes('ai.context.privacy_decision')), 'o contexto registra a decisão em log');
  for (const linha of linhasDeLog) for (const valor of PLANTADOS) assert.ok(!linha.includes(valor), `"${valor}" apareceu no log: ${linha.slice(0, 300)}`);
});

test('m9d027_fonte_restricted_grava_so_o_marcador_no_trecho', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use'] };
    const { run } = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 'teste' }, tx);
    const restrita = await runs.recordSource(ctx, run.id, { sourceType: 'DOCUMENT_CHUNK', sourceRef: 'doc:r', excerpt: 'conteúdo restrito do contrato', classification: 'RESTRICTED' }, tx);
    const interna = await runs.recordSource(ctx, run.id, { sourceType: 'DOCUMENT_CHUNK', sourceRef: 'doc:i', excerpt: 'conteúdo interno', classification: 'INTERNAL' }, tx);
    assert.equal(restrita.excerpt, '[REDIGIDO:restrito]');
    assert.equal(interna.excerpt, 'conteúdo interno');
  });
});
