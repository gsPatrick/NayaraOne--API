'use strict';

// M9-D040 — conversa real com a NAY Documental pelo app (POST /v1/ai/agents/NAY_DOCUMENTAL/chat, provider sandbox): resposta com fontes,
// recusa de pedido proibido, permissão e arquivo não verificado. Só no cluster descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaDocumentalHttp');

let env; let tenant; let code; let arquivo;
/** Com M9D040_EVIDENCIA=1 mostra cada resposta HTTP real (evidência da seção 9 da demanda). */
const chat = async (quem, corpo) => {
  const res = await env.call('POST', `/ai/agents/${code}/chat`, env.tokens[quem], corpo);
  if (process.env.M9D040_EVIDENCIA === '1') console.log(`EVIDENCIA ${quem} ${JSON.stringify(corpo).slice(0, 170)} => ${res.status} ${JSON.stringify(res.body).slice(0, 800)}`);
  return res;
};
const tool = (nome, args) => `[[TOOL:${nome}:${JSON.stringify(args)}]]`;

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D040_HTTP_TEST_PORT) || 21940));
  code = await H.agenteAtivo(env, tenant);
  arquivo = await H.arquivoCommitado(tenant, { fields: { valor_total: 1250 }, positions: { valor_total: { page: 1 } } });
});
after(async () => { await H.encerrar(env, []); });

test('m9d040_http_resposta_com_fontes_campos_com_pagina_e_confianca', { skip: SKIP }, async () => {
  const res = await chat('A:gestor', { message: `Extraia os campos da nota ${tool('documents.extractFields', { fileId: arquivo.id, documentType: 'INVOICE_NF' })} [[RESPOSTA:O valor total da nota é 1250.00, na página 1 [1].]]` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.status, 'COMPLETED');
  assert.equal(d.groundingStatus, 'GROUNDED');
  assert.ok(d.sources.length >= 1 && d.snapshotAt);
  assert.match(d.sources[0].excerpt, /"value":"1250\.00"/);
  const rec = await H.admin("SELECT status, recommendation_type FROM ai.ai_recommendations WHERE related_entity_id = $1", [arquivo.id]);
  assert.deepEqual(rec.rows.map((r) => [r.recommendation_type, r.status]), [['DOCUMENT_EXTRACTION', 'PENDING']]);
  const gravado = await H.admin('SELECT count(*)::int AS n FROM people.person_documents WHERE file_id = $1', [arquivo.id]);
  assert.equal(gravado.rows[0].n, 0, 'nada foi gravado no cadastro');
});

test('m9d040_http_recusas_de_pedido_proibido_e_fora_do_proposito', { skip: SKIP }, async () => {
  for (const [pedido, esperado] of [
    [`Grave no cadastro os campos do documento ${arquivo.id}`, /Não gravo a classificação nem os campos no cadastro/],
    [`Aprove o documento ${arquivo.id}`, /Não aprovo nem valido documento/],
    ['Guarde o texto completo do documento', /Não guardo o texto completo de documentos/],
    ['Qual a capital da França?', /Isso foge do que este assistente pode fazer\./],
  ]) {
    const res = await chat('A:gestor', { message: pedido });
    assert.equal(res.status, 200, `${pedido}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.data.answer, esperado, pedido);
    assert.equal(res.body.data.routingPath, 'RULE');
  }
});

test('m9d040_http_sem_permissao_arquivo_nao_verificado_e_empresa_b', { skip: SKIP }, async () => {
  const pedido = (id) => `Leia o documento ${tool('documents.transcribe', { fileId: id })} [[RESPOSTA:Texto lido [1].]]`;
  const semLeitura = await chat('A:maker', { message: pedido(arquivo.id) });
  assert.equal(semLeitura.status, 403, JSON.stringify(semLeitura.body));
  assert.equal(semLeitura.body.error.code, 'AI_PERMISSION_DENIED');
  const pendente = await H.arquivoCommitado(tenant, { fields: { name: 'Ana' } });
  await H.admin("UPDATE people.files SET scan_status = 'PENDING' WHERE id = $1", [pendente.id]);
  const naoVerificado = await chat('A:gestor', { message: pedido(pendente.id) });
  assert.equal(naoVerificado.status, 200, JSON.stringify(naoVerificado.body));
  assert.match(naoVerificado.body.data.answer, /Não tenho informações suficientes/, 'o conteúdo do arquivo não verificado nunca foi lido');
  const calls = await H.admin("SELECT status, result_summary FROM ai.tool_calls WHERE run_id = $1", [naoVerificado.body.data.runId]);
  assert.deepEqual(calls.rows.map((r) => [r.status, r.result_summary.error]), [['FAILED', 'AI_DOCUMENT_NOT_VERIFIED']]);
  const foraDaAllowlist = await chat('A:gestor', { message: `Leia o documento ${tool('people.updateDocument', {})} [[RESPOSTA:x]]` });
  assert.equal(foraDaAllowlist.status, 403);
  assert.equal(foraDaAllowlist.body.error.code, 'AI_TOOL_NOT_ALLOWED');
  const outraEmpresa = await env.call('POST', `/ai/agents/${code}/chat`, env.tokens['B:gestor'], { message: pedido(arquivo.id) });
  assert.ok([404, 409].includes(outraEmpresa.status), `a empresa B não tem o agente da A: ${outraEmpresa.status}`);
});
