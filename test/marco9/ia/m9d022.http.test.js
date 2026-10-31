'use strict';

// M9-D022 — rotas /v1/ai/ingestions e /v1/ai/files/:id/classification: envio de arquivo real, classificação, ingestão, idempotência, as
// recusas gravadas (a linha REJECTED sobrevive ao 422), URL privada bloqueada e isolamento entre empresas. Só no cluster descartável
// (login real dos usuários do seed de dois tenants; nunca chama MFA nem forja token).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');
const { montarPdf } = require('../_helpers/ragDocs');

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update', 'governance:classification:manage']);
  await grant('CI LEITURA', ['ai:use']);
  env = await startHttpEnv(Number(process.env.M9D022_HTTP_TEST_PORT) || 21722, [['B', 'gestor'], ['B', 'leitura'], ['A', 'gestor']]);
});
after(async () => {
  if (!env) return;
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['B:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

const enviar = (token, linhas) => env.call('POST', '/files', token, { fileName: `doc-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.pdf`, mimeType: 'application/pdf', contentBase64: montarPdf(linhas).toString('base64') });

test('m9d022_http_ciclo_de_ingestao_recusas_e_isolamento', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  // A empresa B recebe o que o teste grava (commit); a empresa A fica limpa para os testes de busca, que exigem resultado exato.
  const gestor = tokens['B:gestor']; const leitura = tokens['B:leitura']; const gestorB = tokens['A:gestor']; // gestorB = a OUTRA empresa
  assert.equal((await call('POST', '/ai/ingestions', gestor, {})).status, 503, 'chave geral desligada');
  for (const t of [gestor, gestorB]) assert.equal((await call('PUT', '/settings/ia.habilitada', t, { value: true })).status, 200);
  assert.equal((await call('POST', '/ai/ingestions', undefined, {})).status, 401);

  const arq = await enviar(gestor, ['Regulamento da área de lazer.', 'O uso da piscina vai das 8h às 20h.']);
  assert.equal(arq.status, 201, JSON.stringify(arq.body));
  const fileId = arq.body.data.id;

  // M9-D920: o arquivo enviado sem classe expressa nasce HIGH (classificação obrigatória), então a primeira ingestão já passa, com a classe HIGH (CONFIDENTIAL na visão antiga).
  const semClasse = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(semClasse.status, 201, JSON.stringify(semClasse.body)); assert.equal(semClasse.body.data.status, 'INDEXED'); assert.equal(semClasse.body.data.classification, 'CONFIDENTIAL');

  assert.equal((await call('PUT', `/ai/files/${fileId}/classification`, leitura, { classification: 'INTERNAL' })).status, 403, 'classificar é de ai:admin e de governance:classification:manage (M9-D920)');
  assert.equal((await call('PUT', `/ai/files/${fileId}/classification`, gestor, { classification: 'SECRETO' })).status, 400);
  assert.equal((await call('PUT', `/ai/files/${fileId}/classification`, gestor, { classification: 'INTERNAL' })).status, 200);

  // Mesmo conteúdo e já indexado na primeira chamada (M9-D920): a repetição devolve a mesma ingestão, sem versão nova.
  const ok = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.id, semClasse.body.data.id); assert.equal(ok.body.data.status, 'INDEXED'); assert.ok(ok.body.data.chunksCount >= 1);
  const repetida = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(repetida.status, 200); assert.equal(repetida.body.data.id, ok.body.data.id); assert.equal(repetida.body.meta.replayed, true);

  // Infectado (marcado pelo antivírus depois do envio): 422 AI_INGEST_MALWARE.
  const outro = await enviar(gestor, ['Documento marcado como infectado.']);
  await admin("UPDATE people.files SET scan_status = 'INFECTED', classification = 'MEDIUM' WHERE id = $1", [outro.body.data.id]);
  const inf = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: outro.body.data.id });
  assert.equal(inf.status, 422); assert.equal(inf.body.error.code, 'AI_INGEST_MALWARE');

  // URL privada e metadados da nuvem: bloqueadas, sem rede.
  for (const url of ['http://169.254.169.254/latest/meta-data', 'https://10.0.0.7/interno.pdf']) {
    const r = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'URL', sourceRef: url, classification: 'INTERNAL' });
    assert.equal(r.status, 422, url); assert.equal(r.body.error.code, 'AI_INGEST_URL_BLOCKED'); assert.equal(r.body.error.message, 'Esta URL não é permitida.');
  }

  // Quem tem só ai:use não indexa arquivo que não enviou; quem enviou, indexa o próprio (se classificado).
  const nega = await call('POST', '/ai/ingestions', leitura, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(nega.status, 403); assert.equal(nega.body.error.code, 'AI_INGEST_NOT_AUTHORIZED');
  const proprio = await enviar(leitura, ['Anotação minha sobre a assembleia.']);
  await admin("UPDATE people.files SET classification = 'MEDIUM' WHERE id = $1", [proprio.body.data.id]);
  assert.equal((await call('POST', '/ai/ingestions', leitura, { sourceKind: 'FILE', sourceRef: proprio.body.data.id })).status, 201);
  assert.equal((await call('POST', '/ai/ingestions', leitura, { sourceKind: 'URL', sourceRef: 'https://a.example.test/x.pdf', classification: 'INTERNAL' })).status, 403);

  // SQL do que ficou gravado (superusuário do cluster descartável): uma linha por pedido que chegou ao pipeline (M9-D920: o arquivo novo já nasce classificado, então a primeira ingestão indexa).
  const gravadas = await admin("SELECT status, step, error_code, source_version, source_kind FROM ai.ingestions WHERE source_id = ANY($1::uuid[]) OR source_kind = 'URL' ORDER BY created_at", [[fileId, outro.body.data.id, proprio.body.data.id]]);
  const resumo = gravadas.rows.map((r) => [r.source_kind, r.status, r.step, r.error_code, r.source_version].join('/'));
  for (const esperado of ['FILE/INDEXED/DONE//1', 'FILE/REJECTED/SCAN/AI_INGEST_MALWARE/1', 'URL/REJECTED/FETCH/AI_INGEST_URL_BLOCKED/1']) assert.ok(resumo.includes(esperado), `${esperado} em ${JSON.stringify(resumo)}`);
  assert.equal((await admin("SELECT count(*)::int AS n FROM ai.chunks WHERE source_type = 'URL'")).rows[0].n, 0, 'nenhum trecho de URL no índice');

  // Outra empresa não vê a ingestão nem indexa o arquivo da primeira: 404 sem revelar existência.
  assert.equal((await call('GET', `/ai/ingestions/${ok.body.data.id}`, gestorB)).status, 404);
  const cross = await call('POST', '/ai/ingestions', gestorB, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(cross.status, 404); assert.equal(cross.body.error.code, 'AI_INGEST_SOURCE_NOT_FOUND');
  assert.equal((await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: 'nao-e-uuid' })).status, 400);
});
