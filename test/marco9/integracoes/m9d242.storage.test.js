'use strict';

// Marco 9, M9-D242 — armazenamento de objetos atrás do port: prefixo da empresa, SHA-256 no envio e na leitura, URL assinada com TTL máximo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d242Env');
const { StorageLocalDiskAdapter } = require('../../../src/features/integrations/providers/storage/storage-local-disk.adapter');
const { StorageSandboxAdapter } = require('../../../src/features/integrations/providers/storage/storage-sandbox.adapter');
const store = require('../../../src/features/integrations/providers/storage/sandbox/storage.sandbox.store');
const { verifySandboxUrl } = require('../../../src/features/integrations/providers/storage/storage.signedUrl');
const diskStorage = require('../../../src/utils/diskStorage');

const adaptadores = () => [['storage-local-disk', new StorageLocalDiskAdapter(null)], ['storage-sandbox', new StorageSandboxAdapter(null)]];
const lerTudo = async (stream) => { const p = []; for await (const c of stream) p.push(c); return Buffer.concat(p); };
const recusa = (code, status) => (e) => e.code === code && e.statusCode === status;

test('storage_prefixo_company_e_isolamento', async () => {
  for (const [nome, adapter] of adaptadores()) {
    const ctx = env.ctxSandbox();
    const minha = env.novaEmpresa();
    const outra = env.novaEmpresa();
    const key = env.chaveDe(minha);
    const corpo = Buffer.from(`conteúdo de ${nome}`);
    const r = await adapter.putObject(ctx, { key, companyId: minha, body: corpo, contentType: 'application/pdf' });
    assert.equal(r.status, 'STORED', nome);
    const lido = await adapter.getObject(ctx, { key, companyId: minha });
    assert.deepEqual(await lerTudo(lido.stream), corpo, nome);
    // A empresa B nunca lê, grava, consulta nem remove a chave da empresa A.
    for (const op of ['getObject', 'headObject', 'deleteObject', 'putObject']) {
      await assert.rejects(adapter[op](ctx, { key, companyId: outra, body: corpo }), recusa('INTEGRATION_STORAGE_KEY_FORBIDDEN', 403), `${nome} ${op}`);
    }
    // Chave sem o prefixo, com caminho que sobe, segmento vazio, caractere fora do alfabeto seguro ou o sufixo reservado dos metadados.
    for (const ruim of ['generic/g1/a.pdf', `company/${minha}/../x.pdf`, `company/${minha}//x.pdf`, `company/${minha}/a b.pdf`, `company/${minha}/a.pdf.meta`, `company/${minha.toUpperCase().slice(0, 8)}/x`, '']) {
      await assert.rejects(adapter.getObject(ctx, { key: ruim, companyId: minha }), recusa('INTEGRATION_STORAGE_KEY_FORBIDDEN', 403), `${nome} chave ${ruim}`);
    }
    await adapter.deleteObject(ctx, { key, companyId: minha });
    await assert.rejects(adapter.getObject(ctx, { key, companyId: minha }), recusa('INTEGRATION_STORAGE_OBJECT_NOT_FOUND', 404), nome);
  }
});

test('storage_sha256_conferido', async () => {
  for (const [nome, adapter] of adaptadores()) {
    const ctx = env.ctxSandbox();
    const empresa = env.novaEmpresa();
    const corpo = Buffer.from(`documento ${nome}`);
    const key = env.chaveDe(empresa);
    // No envio: hash que não confere recusa com 422 e não grava nada.
    await assert.rejects(adapter.putObject(ctx, { key, companyId: empresa, body: corpo, sha256: env.sha256(Buffer.from('outro conteúdo')) }), recusa('INTEGRATION_STORAGE_SHA256_MISMATCH', 422), nome);
    await assert.rejects(adapter.headObject(ctx, { key, companyId: empresa }), recusa('INTEGRATION_STORAGE_OBJECT_NOT_FOUND', 404), `${nome}: nada foi gravado`);
    // Hash certo (em qualquer caixa) grava, e o hash devolvido é o do conteúdo.
    const ok = await adapter.putObject(ctx, { key, companyId: empresa, body: corpo, sha256: env.sha256(corpo).toUpperCase() });
    assert.equal(ok.sha256, env.sha256(corpo));
    // Na leitura: o hash esperado pelo domínio também é conferido, e divergência vira 409.
    await assert.rejects(adapter.getObject(ctx, { key, companyId: empresa, expectedSha256: env.sha256(Buffer.from('x')) }), recusa('INTEGRATION_STORAGE_INTEGRITY_VIOLATION', 409), nome);
    assert.equal((await adapter.getObject(ctx, { key, companyId: empresa, expectedSha256: env.sha256(corpo) })).sha256, env.sha256(corpo));
  }
});

test('storage_leitura_detecta_adulteracao_no_disco', async () => {
  const adapter = new StorageLocalDiskAdapter(null);
  const ctx = env.ctxSandbox();
  const empresa = env.novaEmpresa();
  const relativo = `generic/g1/${env.crypto.randomUUID()}-contrato.pdf`;
  const key = env.chaveDe(empresa, relativo);
  await adapter.putObject(ctx, { key, companyId: empresa, body: Buffer.from('conteúdo original') });
  const arquivo = path.join(diskStorage.UPLOADS_ROOT, relativo);
  assert.ok(fs.existsSync(arquivo), 'o objeto fica no layout de uploads/ que o sistema já usa');
  assert.ok(!fs.readFileSync(arquivo).includes(Buffer.from('conteúdo original')), 'gravado cifrado em repouso');
  const bytes = fs.readFileSync(arquivo);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(arquivo, bytes);
  await assert.rejects(adapter.getObject(ctx, { key, companyId: empresa }), (e) => e.code === 'INTEGRATION_STORAGE_INTEGRITY_VIOLATION' && e.details.reason === 'CIPHER_AUTH_FAILED');
  fs.writeFileSync(arquivo, Buffer.from('texto sem marcador de cifra'));
  await assert.rejects(adapter.getObject(ctx, { key, companyId: empresa, expectEncrypted: true }), (e) => e.details.reason === 'NO_CIPHER_MARKER');
});

test('storage_url_assinada_ttl_maximo', async () => {
  const adapter = new StorageSandboxAdapter(null);
  const ctx = env.ctxSandbox();
  const empresa = env.novaEmpresa();
  const key = env.chaveDe(empresa);
  await adapter.putObject(ctx, { key, companyId: empresa, body: Buffer.from('foto') });
  // TTL pedido 3600 s, máximo 900 s: sai 900.
  const r = await adapter.getSignedUrl(ctx, { key, companyId: empresa, ttlSeconds: 3600, maxTtlSeconds: 900 });
  assert.equal(r.ttlSeconds, 900);
  assert.ok(Math.abs(new Date(r.expiresAt).getTime() - (Date.now() + 900000)) < 5000);
  assert.deepEqual(verifySandboxUrl(store.SECRET, r.url).ok, true, 'vale agora');
  assert.equal(verifySandboxUrl(store.SECRET, r.url, Date.now() + 899000).ok, true, 'vale até o fim do prazo');
  assert.deepEqual(verifySandboxUrl(store.SECRET, r.url, Date.now() + 901000), { ok: false, reason: 'EXPIRED' }, 'expira em 900 s');
  assert.equal(verifySandboxUrl(store.SECRET, r.url.replace('method=GET', 'method=PUT')).ok, false, 'o método faz parte da assinatura');
  assert.equal(verifySandboxUrl(store.SECRET, r.url.replace(/exp=\d+/, 'exp=9999999999')).ok, false, 'estender o prazo invalida a assinatura');
  // TTL menor que o máximo vale como pedido; pedido ausente ou inválido vale o máximo.
  assert.equal((await adapter.getSignedUrl(ctx, { key, companyId: empresa, ttlSeconds: 60, maxTtlSeconds: 900 })).ttlSeconds, 60);
  assert.equal((await adapter.getSignedUrl(ctx, { key, companyId: empresa, ttlSeconds: -5, maxTtlSeconds: 900 })).ttlSeconds, 900);
  // Objeto de outra empresa: nem URL.
  await assert.rejects(adapter.getSignedUrl(ctx, { key, companyId: env.novaEmpresa(), ttlSeconds: 60 }), recusa('INTEGRATION_STORAGE_KEY_FORBIDDEN', 403));
});

test('storage_sandbox_falhas_por_cabecalho', async () => {
  const adapter = new StorageSandboxAdapter(null);
  const ctx = env.ctxSandbox();
  const empresa = env.novaEmpresa();
  const key = env.chaveDe(empresa);
  await assert.rejects(adapter.putObject(ctx, { key, companyId: empresa, body: Buffer.from('a'), headers: { 'x-sandbox-fail': '503' } }), (e) => e.status === 503);
  await assert.rejects(adapter.headObject(ctx, { key, companyId: empresa }), recusa('INTEGRATION_STORAGE_OBJECT_NOT_FOUND', 404), 'a falha injetada não gravou nada');
  assert.equal((await adapter.healthCheck(ctx, { headers: { 'x-sandbox-fail': '500' } })).ok, false);
  assert.equal((await adapter.healthCheck(ctx)).ok, true);
  assert.deepEqual(adapter.classifyError({ status: 503 }), { class: 'TRANSIENT', code: 'HTTP_503' });
  assert.equal(adapter.mapStatus('STORED'), 'STORED');
  assert.equal(adapter.mapStatus('inedito'), null);
});
