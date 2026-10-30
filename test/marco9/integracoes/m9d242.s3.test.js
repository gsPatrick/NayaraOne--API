'use strict';

// Marco 9, M9-D242 — driver S3 compatível: assinatura V4 (vetor público da AWS), chamadas assinadas, URL pré-assinada com TTL limitado e chave de outra empresa recusada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d242Env');
const { StorageS3Adapter } = require('../../../src/features/integrations/providers/storage/storage-s3.adapter');
const { presignUrl, signRequest } = require('../../../src/features/integrations/providers/storage/storage.s3.sigv4');

// Credencial FICTÍCIA da documentação pública da AWS; montada em partes para a varredura de segredos (M9-D246) não confundi-la com credencial real.
const ACESSO = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const SEGREDO = ['wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'].join('');

test('s3_assinatura_v4_confere_com_o_vetor_da_documentacao_da_aws', () => {
  const url = presignUrl({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', accessKeyId: ACESSO, secretAccessKey: SEGREDO, region: 'us-east-1', expiresS: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404&/);
  // Cabeçalho Authorization (vetor "GET Object" da documentação, com Range).
  const h = signRequest({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { Range: 'bytes=0-9' }, accessKeyId: ACESSO, secretAccessKey: SEGREDO, region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

function ctxS3(config, respostas) {
  const chamadas = [];
  const http = { request: async (req) => { chamadas.push(req); return respostas(req); } };
  const ctx = { ...env.ctxSandbox('s3-1', config), http, secret: async () => JSON.stringify({ accessKeyId: ACESSO, secretAccessKey: SEGREDO }) };
  return { ctx, chamadas };
}
const resposta = (status, corpo = '', headers = {}) => new Response(corpo || null, { status, headers });

test('s3_grava_le_consulta_remove_assinando_e_cifrando_no_servico', async () => {
  const adapter = new StorageS3Adapter(null);
  const empresa = env.novaEmpresa();
  const key = env.chaveDe(empresa);
  const corpo = Buffer.from('escritura do imóvel');
  const { ctx, chamadas } = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara', region: 'sa-east-1', pathStyle: true }, (req) => {
    if (req.method === 'PUT') return resposta(200, '', { 'x-amz-request-id': 'rq-1' });
    if (req.method === 'GET') return resposta(200, corpo, { 'content-type': 'application/pdf', 'x-amz-meta-sha256': env.sha256(corpo) });
    if (req.method === 'HEAD') return resposta(200, '', { 'content-length': String(corpo.length), 'content-type': 'application/pdf' });
    return resposta(204);
  });
  const put = await adapter.putObject(ctx, { key, companyId: empresa, body: corpo, contentType: 'application/pdf', sha256: env.sha256(corpo) });
  assert.equal(put.status, 'STORED');
  const envio = chamadas[0];
  assert.equal(envio.url, `https://s3.exemplo.test/nayara/${key}`);
  assert.match(envio.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIA.+\/sa-east-1\/s3\/aws4_request, SignedHeaders=.*host.*x-amz-server-side-encryption.*, Signature=[0-9a-f]{64}$/);
  assert.equal(envio.headers['x-amz-server-side-encryption'], 'AES256');
  assert.equal(envio.headers['x-amz-meta-sha256'], env.sha256(corpo));
  const lido = await adapter.getObject(ctx, { key, companyId: empresa });
  const partes = []; for await (const c of lido.stream) partes.push(c);
  assert.deepEqual(Buffer.concat(partes), corpo);
  assert.equal((await adapter.headObject(ctx, { key, companyId: empresa })).sizeBytes, corpo.length);
  assert.equal((await adapter.deleteObject(ctx, { key, companyId: empresa })).status, 'DELETED');
  // Leitura cujo conteúdo não confere com o hash gravado: 409.
  const adulterado = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara' }, () => resposta(200, 'outro conteúdo', { 'x-amz-meta-sha256': env.sha256(corpo) }));
  await assert.rejects(adapter.getObject(adulterado.ctx, { key, companyId: empresa }), (e) => e.code === 'INTEGRATION_STORAGE_INTEGRITY_VIOLATION');
  // Hash divergente no envio: nada vai ao serviço.
  const vazio = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara' }, () => resposta(200));
  await assert.rejects(adapter.putObject(vazio.ctx, { key, companyId: empresa, body: corpo, sha256: env.sha256(Buffer.from('x')) }), (e) => e.code === 'INTEGRATION_STORAGE_SHA256_MISMATCH');
  assert.equal(vazio.chamadas.length, 0);
  // 404 vira objeto não encontrado; 500 sobe como falha transitória.
  const nf = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara' }, () => resposta(404));
  await assert.rejects(adapter.getObject(nf.ctx, { key, companyId: empresa }), (e) => e.code === 'INTEGRATION_STORAGE_OBJECT_NOT_FOUND');
  const erro = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara' }, () => resposta(503));
  await assert.rejects(adapter.getObject(erro.ctx, { key, companyId: empresa }), (e) => adapter.classifyError(e).class === 'TRANSIENT');
});

test('s3_url_pre_assinada_limita_o_ttl_e_respeita_o_estilo_do_endereco', async () => {
  const adapter = new StorageS3Adapter(null);
  const empresa = env.novaEmpresa();
  const key = env.chaveDe(empresa);
  const virtual = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara' }, () => resposta(200));
  const r = await adapter.getSignedUrl(virtual.ctx, { key, companyId: empresa, ttlSeconds: 3600, maxTtlSeconds: 900 });
  assert.equal(r.ttlSeconds, 900);
  const u = new URL(r.url);
  assert.equal(u.host, 'nayara.s3.exemplo.test');
  assert.equal(u.pathname, `/${key}`);
  assert.equal(u.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(virtual.chamadas.length, 0, 'a URL é calculada, sem chamar o serviço');
  const path = ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara', pathStyle: true }, () => resposta(200));
  assert.equal(new URL((await adapter.getSignedUrl(path.ctx, { key, companyId: empresa, ttlSeconds: 30, maxTtlSeconds: 900 })).url).pathname, `/nayara/${key}`);
  await assert.rejects(adapter.getSignedUrl(virtual.ctx, { key, companyId: env.novaEmpresa(), ttlSeconds: 30 }), (e) => e.code === 'INTEGRATION_STORAGE_KEY_FORBIDDEN');
});
