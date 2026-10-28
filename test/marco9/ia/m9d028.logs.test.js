'use strict';

// M9-D028 — logs e tabelas ai_* sem secrets: um segredo plantado em argumento de ferramenta, erro de provider e variável de
// ambiente nunca aparece no que o logger grava (capturado em memória, o mesmo texto que vai ao stdout) nem em ai_*.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const logger = require('../../../src/utils/logger');
const { redactDeep } = require('../../../src/shared/redaction');
const { safeLogger } = require('../../../src/features/ai/audit');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');

const CANARIO = 'SECRET-CANARY-7f3a';
let tenantA;
let linhas;
let removerTap;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

test('m9d028_logs_sem_secrets_nem_tokens', async () => {
  linhas = [];
  removerTap = logger.addLogTap((linha) => linhas.push(linha));
  process.env.AI_PROVIDER_API_KEY = CANARIO;
  try {
    // 1) argumento de ferramenta, 2) erro de provider (mensagem e cabeçalho), 3) variável de ambiente, 4) documento e prompt brutos.
    safeLogger.info({ tool: 'crm.buscar', args: { apiKey: CANARIO, nota: `senha: ${CANARIO}`, auth: `Bearer ${CANARIO}abcdef123456` } }, 'chamada de ferramenta');
    const erro = new Error(`provider respondeu 401 para Bearer ${CANARIO}abcdef123456`);
    erro.response = { headers: { authorization: `Bearer ${CANARIO}`, 'x-api-key': CANARIO } };
    safeLogger.error(erro, 'falha do provider');
    safeLogger.error({ err: erro, providerName: 'sandbox' }, 'falha do provider com contexto');
    safeLogger.warn({ env: process.env }, 'ambiente');
    safeLogger.info({ prompt: `PROMPT-BRUTO ${CANARIO}`, documentText: 'DOCUMENTO-INTEIRO '.repeat(50), rawResponse: 'RESPOSTA-BRUTA' }, 'run');
    logger.info({ args: { token: CANARIO } }, 'log direto do logger comum');
  } finally {
    removerTap();
    delete process.env.AI_PROVIDER_API_KEY;
  }
  const saida = linhas.join('');
  assert.ok(linhas.length >= 5, 'o logger gravou as linhas');
  assert.ok(!saida.includes(CANARIO), 'o segredo plantado não pode aparecer no log');
  assert.ok(!saida.includes('PROMPT-BRUTO'), 'prompt bruto nunca vai ao log');
  assert.ok(!saida.includes('DOCUMENTO-INTEIRO'), 'documento completo nunca vai ao log');
  assert.ok(!saida.includes('RESPOSTA-BRUTA'), 'resposta bruta do provider nunca vai ao log');
  assert.match(saida, /falha do provider/, 'a mensagem de negócio continua no log');
  assert.match(saida, /sandbox/);

  // Nas tabelas ai_*: segredo plantado em resumo de entrada/saída, argumentos de ferramenta, fonte e código de erro.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use'] };
    const { run } = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 'teste', inputSummary: `consulte com apiKey=${CANARIO} e Bearer ${CANARIO}abcdef123456` }, tx);
    await runs.recordSource(ctx, run.id, { sourceType: 'TOOL_RESULT', sourceRef: 't:1', excerpt: `resposta com password=${CANARIO}` }, tx);
    await runs.finishRun(ctx, run.id, { status: 'FAILED', outputSummary: `falhou: authorization: Bearer ${CANARIO}abcdef123456`, errorCode: 'PROVIDER_ERROR' }, tx);
    await runs.recordRuleRun(ctx, {
      agentName: 'NAY_TESTE', inputSummary: `entrada token ${CANARIO}`, outputSummary: 'ok',
      toolCallsJson: [{ tool: 'x', argsSanitized: { apiKey: CANARIO, texto: `secret=${CANARIO}` }, resultSummary: `Bearer ${CANARIO}abcdef123456` }],
    }, tx);
    const tabelas = await q(
      `SELECT (SELECT coalesce(string_agg(r::text, ' '), '') FROM ai.ai_runs r) AS runs, (SELECT coalesce(string_agg(s::text, ' '), '') FROM ai.ai_sources s) AS fontes`, {}, tx
    );
    assert.ok(!tabelas[0].runs.includes(CANARIO), 'segredo fora de ai.ai_runs');
    assert.ok(!tabelas[0].fontes.includes(CANARIO), 'segredo fora de ai.ai_sources');
  });
});

test('m9d028_safe_logger_delega_a_redaction_da_d246', () => {
  // Nenhuma regra de detecção própria: o mesmo resultado da biblioteca única e nenhuma expressão regular de segredo no arquivo.
  const exemplo = { a: `Bearer ${CANARIO}abcdef123456`, b: { password: 'x1', cpf: '529.982.247-25' }, lista: [`token ${CANARIO}`] };
  assert.deepEqual(safeLogger.sanitize(exemplo), redactDeep(exemplo));
  const fonte = fs.readFileSync(path.join(__dirname, '../../../src/features/ai/audit/safeLogger.js'), 'utf8');
  assert.match(fonte, /require\('\.\.\/\.\.\/\.\.\/shared\/redaction'\)/);
  assert.doesNotMatch(fonte, /new RegExp|=\s*\/.+\/[gimsuy]*;/, 'sem regex própria de detecção');
  assert.deepEqual(safeLogger.sanitize({ prompt: 'p', rawPrompt: 'p', ok: 1 }), { ok: 1 });
});
