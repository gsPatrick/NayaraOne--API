'use strict';

// Marco 9, M9-D242 (reabertura M3 da auditoria cega) — o endereço do S3 nasce de texto livre da configuração (endpoint e bucket):
// endpoint hostil (IP interno/metadados, "#", "@", "/", sufixo interno) ou bucket fora do formato nunca vira chamada nem URL assinada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d242Env');
const { StorageS3Adapter } = require('../../../src/features/integrations/providers/storage/storage-s3.adapter');

const ACESSO = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const SEGREDO = ['wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'].join('');

function ctxS3(config) {
  const chamadas = [];
  const http = { request: async (req) => { chamadas.push(req); return new Response(null, { status: 200 }); } };
  return { ctx: { ...env.ctxSandbox('s3-destino', config), http, secret: async () => JSON.stringify({ accessKeyId: ACESSO, secretAccessKey: SEGREDO }) }, chamadas };
}

const HOSTIS = [
  { endpoint: '169.254.169.254', bucket: 'nayara' },
  { endpoint: '10.0.0.5', bucket: 'nayara', pathStyle: true },
  { endpoint: 's3.exemplo.test#@10.0.0.5', bucket: 'nayara' },
  { endpoint: 's3.exemplo.test@10.0.0.5', bucket: 'nayara' },
  { endpoint: 's3.exemplo.test/x', bucket: 'nayara' },
  { endpoint: 'meu-servidor.internal', bucket: 'nayara' },
  { endpoint: 's3.exemplo.test', bucket: 'a/../b' },
  { endpoint: 's3.exemplo.test', bucket: 'Nayara' },
  { endpoint: 's3.exemplo.test', bucket: 'nayara', region: 'x/../y' },
  { bucket: 'nayara' },
];

test('s3_endpoint_ou_bucket_hostil_nao_gera_chamada_nem_url_assinada', async () => {
  const adapter = new StorageS3Adapter(null);
  const empresa = env.novaEmpresa();
  const key = env.chaveDe(empresa);
  const corpo = Buffer.from('x');
  for (const config of HOSTIS) {
    const { ctx, chamadas } = ctxS3(config);
    const uso = [
      () => adapter.putObject(ctx, { key, companyId: empresa, body: corpo, sha256: env.sha256(corpo) }),
      () => adapter.getObject(ctx, { key, companyId: empresa }),
      () => adapter.headObject(ctx, { key, companyId: empresa }),
      () => adapter.deleteObject(ctx, { key, companyId: empresa }),
      () => adapter.getSignedUrl(ctx, { key, companyId: empresa, ttlSeconds: 60 }),
    ];
    for (const fazer of uso) await assert.rejects(fazer(), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', JSON.stringify(config));
    assert.equal(chamadas.length, 0, `nenhuma chamada de rede para ${JSON.stringify(config)}`);
  }
});

test('s3_configuracao_legitima_segue_funcionando_nos_dois_estilos', async () => {
  const adapter = new StorageS3Adapter(null);
  const empresa = env.novaEmpresa();
  const key = env.chaveDe(empresa);
  const virtual = await adapter.getSignedUrl(ctxS3({ endpoint: 's3.sa-east-1.amazonaws.com', bucket: 'nayara-docs', region: 'sa-east-1' }).ctx, { key, companyId: empresa, ttlSeconds: 60 });
  assert.equal(new URL(virtual.url).host, 'nayara-docs.s3.sa-east-1.amazonaws.com');
  const path = await adapter.getSignedUrl(ctxS3({ endpoint: 's3.exemplo.test', bucket: 'nayara', pathStyle: true }).ctx, { key, companyId: empresa, ttlSeconds: 60 });
  assert.equal(new URL(path.url).pathname, `/nayara/${key}`);
});
