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
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
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

  // Sem classificação: 422 com o código do livro, e a recusa fica gravada.
  const semClasse = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(semClasse.status, 422); assert.equal(semClasse.body.error.code, 'AI_INGEST_UNCLASSIFIED'); assert.equal(semClasse.body.error.message, 'Classifique o documento antes de indexá-lo.');
  const gravada = await call('GET', `/ai/ingestions/${semClasse.body.error.details.ingestionId}`, gestor);
  assert.equal(gravada.status, 200); assert.equal(gravada.body.data.status, 'REJECTED'); assert.equal(gravada.body.data.step, 'CLASSIFY');

  assert.equal((await call('PUT', `/ai/files/${fileId}/classification`, leitura, { classification: 'INTERNAL' })).status, 403, 'classificar é de ai:admin');
  assert.equal((await call('PUT', `/ai/files/${fileId}/classification`, gestor, { classification: 'SECRETO' })).status, 400);
  assert.equal((await call('PUT', `/ai/files/${fileId}/classification`, gestor, { classification: 'INTERNAL' })).status, 200);

  const ok = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.data.status, 'INDEXED'); assert.ok(ok.body.data.chunksCount >= 1);
  const repetida = await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(repetida.status, 200); assert.equal(repetida.body.data.id, ok.body.data.id); assert.equal(repetida.body.meta.replayed, true);

  // Infectado (marcado pelo antivírus depois do envio): 422 AI_INGEST_MALWARE.
  const outro = await enviar(gestor, ['Documento marcado como infectado.']);
  await admin("UPDATE people.files SET scan_status = 'INFECTED', classification = 'INTERNAL' WHERE id = $1", [outro.body.data.id]);
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
  await admin("UPDATE people.files SET classification = 'INTERNAL' WHERE id = $1", [proprio.body.data.id]);
  assert.equal((await call('POST', '/ai/ingestions', leitura, { sourceKind: 'FILE', sourceRef: proprio.body.data.id })).status, 201);
  assert.equal((await call('POST', '/ai/ingestions', leitura, { sourceKind: 'URL', sourceRef: 'https://a.example.test/x.pdf', classification: 'INTERNAL' })).status, 403);

  // Outra empresa não vê a ingestão nem indexa o arquivo da primeira: 404 sem revelar existência.
  assert.equal((await call('GET', `/ai/ingestions/${ok.body.data.id}`, gestorB)).status, 404);
  const cross = await call('POST', '/ai/ingestions', gestorB, { sourceKind: 'FILE', sourceRef: fileId });
  assert.equal(cross.status, 404); assert.equal(cross.body.error.code, 'AI_INGEST_SOURCE_NOT_FOUND');
  assert.equal((await call('POST', '/ai/ingestions', gestor, { sourceKind: 'FILE', sourceRef: 'nao-e-uuid' })).status, 400);
});
