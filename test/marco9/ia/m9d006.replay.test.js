'use strict';

// Marco 9, M9-D006 — ai.tool_calls: replay não reexecuta a tool, estados percorridos, sanitização dos argumentos, campo sensitive e
// bloqueios com motivo. Postgres real com nayara_runtime (RLS) em transação com rollback; nenhuma chamada a modelo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { schemaBasico, ferramenta, abrirRun, rodar, linhas, sha, inserirEmExecucao } = require('../_helpers/iaToolCalls');
const { semPii } = require('../_helpers/iaPrivacidade');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });
async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}
/** Hash canônico escrito à mão no teste (chaves ordenadas), independente do código de produção. */
const canonico = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
};

test('m9d006_replay_nao_reexecuta_tool', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const runId = await abrirRun(ctx, tx);
    const { tool, execucoes } = ferramenta();
    const entrada = { ref: 'X' };
    const a = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: entrada, seq: 1 });
    const b = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ...entrada }, seq: 1 });
    assert.equal(a.status, 'SUCCEEDED');
    assert.equal(a.replayed, undefined);
    assert.equal(b.status, 'SUCCEEDED');
    assert.equal(b.replayed, true, 'a segunda vez devolve replayed=true');
    assert.deepEqual(b.output, { ok: true, itens: 3 }, 'o resultado anterior volta');
    assert.equal(execucoes.length, 1, 'a tool executou uma única vez');
    const rows = await linhas(runId, tx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'SUCCEEDED');
    assert.equal(rows[0].idempotency_key, `${runId}:1:${rows[0].args_hash}`, 'chave padrão run_id:seq:args_hash');
    assert.equal(rows[0].args_hash, sha(canonico(entrada)));
    assert.equal(rows[0].tool_version, '1');
    assert.equal(rows[0].permission_code, 'crm:read');
    assert.ok(rows[0].latency_ms >= 0 && rows[0].finished_at && rows[0].result_hash);
    // outro seq (nova chamada do mesmo run) executa de novo; outra ordem com argumentos diferentes também
    const c = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: entrada, seq: 2 });
    assert.equal(c.replayed, undefined);
    assert.equal(execucoes.length, 2);
    // sem seq, a ordem é atribuída (3) e a chamada executa
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'Y' } });
    assert.deepEqual((await linhas(runId, tx)).map((r) => r.seq), [1, 2, 3]);
    // mesma ordem com argumentos diferentes: outra chave, mas a ordem já está ocupada
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'Z' }, seq: 1 }), 409, 'AI_TOOL_CALL_SEQ_CONFLICT');
  });
});

test('m9d006_estados_sao_percorridos_e_a_trilha_nao_tem_argumento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const runId = await abrirRun(ctx, tx);
    const { tool } = ferramenta();
    const r = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'X', cpf: '123.456.789-09' }, seq: 1 });
    const [linha] = await linhas(runId, tx);
    const trilha = await q("SELECT action, before_json::text AS antes, after_json::text AS depois FROM audit.audit_log WHERE entity_type = 'AiToolCall' AND entity_id = :id ORDER BY occurred_at, created_at", { id: linha.id }, tx);
    assert.deepEqual(trilha.map((t) => t.action), ['ai.tool_call.requested', 'ai.tool_call.state_changed']);
    assert.match(trilha[1].antes, /"status": "REQUESTED"/);
    assert.match(trilha[1].depois, /"status": "SUCCEEDED"/);
    for (const t of trilha) assert.ok(!t.antes.includes('123.456') && !t.depois.includes('123.456') && !t.depois.includes('itens'), 'a auditoria não leva argumento nem resultado');
    assert.equal(r.recorder.current.status, 'SUCCEEDED');
  });
});

test('m9d006_replay_de_falha_devolve_a_falha_anterior_sem_reexecutar', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const runId = await abrirRun(ctx, tx);
    const erro = Object.assign(new Error('falhou'), { code: 'CRM_FORA_DO_AR' });
    const { tool, execucoes } = ferramenta({ falha: erro });
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'X' }, seq: 1 }), undefined, 'CRM_FORA_DO_AR');
    const outra = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'X' }, seq: 1 });
    assert.equal(outra.status, 'FAILED');
    assert.equal(outra.replayed, true);
    assert.deepEqual(outra.output, { error: 'CRM_FORA_DO_AR' });
    assert.equal(execucoes.length, 1, 'não reexecuta a que falhou (um novo run gera nova chave)');
    const [linha] = await linhas(runId, tx);
    assert.equal(linha.status, 'FAILED');
  });
});

test('m9d006_chamada_em_andamento_devolve_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const runId = await abrirRun(ctx, tx);
    const { tool, execucoes } = ferramenta();
    const entrada = { ref: 'X' };
    const hash = sha(canonico(entrada));
    await inserirEmExecucao(tenantA, tx, runId, { tool: tool.name, argsHash: hash, chave: `${runId}:1:${hash}` });
    const err = await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool, input: entrada, seq: 1 }), 409, 'AI_TOOL_CALL_IN_PROGRESS');
    assert.equal(err.message, 'Esta chamada ainda está em andamento.');
    assert.equal(execucoes.length, 0, 'não executa enquanto a primeira não termina');
  });
});

test('m9d006_args_sem_pii_gravados', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const runId = await abrirRun(ctx, tx);
    const { tool } = ferramenta({ resultado: { contato: 'maria@exemplo.com.br', cpf: '123.456.789-09', total: 2 } });
    const args = { ref: 'X', cpf: '123.456.789-09', nota: 'ligar (11) 91234-5678, e-mail maria@exemplo.com.br, senha: abc12345 e 11.222.333/0001-81' };
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: args, seq: 1 });
    const [linha] = await linhas(runId, tx);
    assert.equal(linha.args_sanitized.cpf, '[REDIGIDO:cpf]');
    assert.equal(linha.args_sanitized.nota, 'ligar [REDIGIDO:telefone], e-mail [REDIGIDO:email], senha: [REDIGIDO:senha] e [REDIGIDO:cnpj]');
    assert.equal(linha.args_sanitized.ref, 'X');
    const [texto] = await q('SELECT to_jsonb(t)::text AS t FROM ai.tool_calls t WHERE id = :id', { id: linha.id }, tx);
    for (const valor of ['123.456.789-09', '91234-5678', 'maria@exemplo', 'abc12345', '11.222.333']) assert.ok(!texto.t.includes(valor), `"${valor}" apareceu em claro`);
    assert.ok(semPii(texto.t), 'a varredura da linha inteira não acha padrão de PII (adv_pii_no_log_redaction)');
    assert.deepEqual(linha.result_summary, { contato: '[REDIGIDO:email]', cpf: '[REDIGIDO:cpf]', total: 2 }, 'o resultado também é redigido');
    assert.equal(linha.args_hash, sha(canonico(args)), 'o hash é do argumento original');
  });
});

test('m9d006_campo_sensitive_so_hash', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const runId = await abrirRun(ctx, tx);
    const { tool } = ferramenta({ inputSchema: schemaBasico({ detalhe: { type: 'object', properties: { chave: { type: 'string', sensitive: true } } } }) });
    const a = { ref: 'X', documento: 'DOC-SIGILOSO-777', detalhe: { chave: 'chave-secreta-xyz' } };
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: a, seq: 1 });
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ...a, documento: 'DOC-OUTRO-888' }, seq: 2 });
    const [l1, l2] = await linhas(runId, tx);
    assert.equal(l1.args_sanitized.documento, '[REDIGIDO:sensivel]');
    assert.equal(l1.args_sanitized.detalhe.chave, '[REDIGIDO:sensivel]', 'também em campo aninhado');
    assert.equal(l1.args_sanitized.ref, 'X');
    const [texto] = await q('SELECT to_jsonb(t)::text AS t FROM ai.tool_calls t WHERE run_id = :id', { id: runId }, tx);
    for (const valor of ['DOC-SIGILOSO', 'DOC-OUTRO', 'chave-secreta']) assert.ok(!texto.t.includes(valor), `"${valor}" não pode ser gravado`);
    assert.notEqual(l1.args_hash, l2.args_hash, 'o hash distingue os dois valores sem guardá-los');
    assert.equal(l1.args_hash, sha(canonico(a)), 'o hash cobre o valor sensível, que não é gravado');
  });
});

test('m9d006_bloqueada_grava_motivo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const runId = await abrirRun(ctx, tx);
    const { tool, execucoes } = ferramenta();
    // 1) ferramenta fora do registro
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool: { ...tool }, nome: 'crm.nao_existe', input: { ref: 'X' }, seq: 1, over: { registry: {} } }), 403, 'AI_CAPABILITY_FORBIDDEN');
    // 2) argumento inválido (campo desconhecido)
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'X', intruso: 1 }, seq: 2 }), 400, 'AI_TOOL_ARGS_INVALID');
    // 3) a tool tenta o que a NAY não pode (acessar o banco)
    const maliciosa = ferramenta({ nome: 'crm.maliciosa', over: { execute: async (c) => c.sequelize.query('select 1') } });
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool: maliciosa.tool, input: { ref: 'X' }, seq: 3 }), 403, 'AI_CAPABILITY_FORBIDDEN');
    // 4) ação crítica sem workflow
    const critica = ferramenta({ nome: 'fin.pagar', over: { riskLevel: 'HIGH', requiresHumanApproval: true } });
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool: critica.tool, input: { ref: 'X' }, seq: 4 }), 403, 'AI_CAPABILITY_FORBIDDEN');
    assert.equal(execucoes.length, 0);
    assert.equal(critica.execucoes.length, 0);
    const rows = await linhas(runId, tx);
    assert.deepEqual(rows.map((r) => r.status), ['BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    assert.deepEqual(rows.map((r) => r.blocked_reason), ['tool_nao_registrada', 'SCHEMA', 'sequelize', 'acao_critica_sem_workflow']);
    assert.ok(rows.every((r) => r.finished_at), 'estado final com fim');
    // cada bloqueio gera o evento ai.tool_call.blocked no outbox, na mesma transação
    const eventos = await q("SELECT aggregate_id::text AS id, event_type FROM integration.outbox_events WHERE event_type = 'ai.tool_call.blocked' AND aggregate_id IN (:ids)", { ids: rows.map((r) => r.id) }, tx);
    assert.equal(eventos.length, 4);
    // a mesma chamada bloqueada, repetida, recusa de novo sem executar nem duplicar
    await rejeita(rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'X', intruso: 1 }, seq: 2 }), 409, 'AI_TOOL_CALL_BLOCKED');
    assert.equal((await linhas(runId, tx)).length, 4);
  });
});

test('m9d006_resumo_do_resultado_e_curto_e_o_limite_e_parametro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const runId = await abrirRun(ctx, tx);
    const documento = 'Cláusula do contrato. '.repeat(500);
    const { tool } = ferramenta({ resultado: { texto: documento } });
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'A' }, seq: 1 });
    await upsertSetting('ia.tool_calls.resultado_max_caracteres', 150, ctx, ctx.userId, tx);
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'B' }, seq: 2 });
    const [l1, l2] = await linhas(runId, tx);
    assert.equal(l1.result_summary.truncated, true);
    assert.equal(l1.result_summary.preview.length, 2000, 'padrão do parâmetro: 2000 caracteres');
    assert.equal(l2.result_summary.preview.length, 150, 'o parâmetro da empresa vale');
    assert.ok(l2.result_summary.chars > 10000);
    assert.equal(l1.result_hash.length, 64, 'o hash é do resultado inteiro');
    assert.ok(!JSON.stringify(l2.result_summary).includes(documento));
  });
});
