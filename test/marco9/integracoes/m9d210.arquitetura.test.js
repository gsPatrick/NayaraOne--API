'use strict';

// M9-D210 — estrutura de pastas e isolamento de SDK. Teste de arquitetura: lê o código-fonte, não usa banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scanBoundaries, API_ROOT } = require('../../../scripts/lib/integrationBoundaries');
const { DEFAULT_SDK_DENYLIST, isSdkPackage } = require('../../../src/features/integrations/http/sdkPolicy');
const { criarFixture, achados } = require('../_helpers/boundariesFixture');

const INTEG = path.join(API_ROOT, 'src', 'features', 'integrations');
const scan = (arquivos, opts) => achados(scanBoundaries, arquivos, opts);
const codigos = (v) => v.map((x) => x.code);

test('arvore_do_modulo_existe_com_os_arquivos_base_e_o_barrel', () => {
  for (const pasta of ['registry', 'dispatch', 'webhooks', 'health', 'secrets', 'http', 'providers']) {
    assert.ok(fs.statSync(path.join(INTEG, pasta)).isDirectory(), `integrations/${pasta}`);
  }
  for (const arquivo of ['index.js', 'registry/IntegrationAdapter.js', 'registry/adapterRegistry.js', 'registry/registry.service.js',
    'dispatch/dispatchStateMachine.js', 'http/IntegrationHttpClient.js', 'http/egressPolicy.js', 'http/tlsPolicy.js', 'secrets/fileMountedStore.js', 'secrets/httpVaultStore.js', 'webhooks/index.js']) {
    assert.ok(fs.existsSync(path.join(INTEG, arquivo)), `integrations/${arquivo}`);
  }
  const dominios = ['messaging', 'portal', 'bank', 'signature', 'financing', 'insurance', 'email', 'social', 'fiscal', 'storage', 'identity', 'analytics', 'site'];
  for (const d of dominios) assert.ok(fs.existsSync(path.join(INTEG, 'providers', d, `${d}.port.js`)), `port de ${d}`);
  assert.ok(fs.existsSync(path.join(INTEG, 'providers/messaging/sandbox/messaging-sandbox.adapter.js')));
  assert.ok(fs.existsSync(path.join(INTEG, 'providers/portal/sandbox/portal-sandbox.adapter.js')));
  const barrel = require('../../../src/features/integrations');
  for (const nome of ['IntegrationAdapter', 'AdapterRegistry', 'IntegrationHttpClient', 'webhooks']) assert.ok(barrel[nome], `barrel exporta ${nome}`);
});

test('arquitetura_codigo_real_tem_zero_violacoes_de_fronteira', () => {
  assert.deepEqual(scanBoundaries(), []);
});

test('arquitetura_sdk_apenas_em_providers', () => {
  assert.deepEqual(DEFAULT_SDK_DENYLIST.slice(0, 3), ['twilio', '@sendgrid/mail', 'aws-sdk']);
  const r = scan({
    'features/crm/x.js': "const twilio = require('twilio');\n",
    'features/finance/y.js': "const { S3 } = require('@aws-sdk/client-s3');\n",
    'features/legal/z.js': "import Stripe from 'stripe';\n",
    'features/integrations/providers/messaging/twilio/twilio.adapter.js': "const twilio = require('twilio');\n",
  });
  assert.deepEqual(r.map((x) => [x.code, x.file, x.line]), [
    ['ARCH_SDK_OUTSIDE_ADAPTER', 'src/features/crm/x.js', 1],
    ['ARCH_SDK_OUTSIDE_ADAPTER', 'src/features/finance/y.js', 1],
    ['ARCH_SDK_OUTSIDE_ADAPTER', 'src/features/legal/z.js', 1],
  ], 'só o adapter dentro de providers pode importar o SDK; o arquivo e a linha saem no relatório');
  assert.ok(isSdkPackage('@aws-sdk/client-s3/dist/x') && isSdkPackage('googleapis') && !isSdkPackage('express'));
  // A lista é o parâmetro integration.sdk.denylist: um pacote acrescentado pela empresa também vale.
  assert.deepEqual(codigos(scan({ 'features/crm/x.js': "require('minha-lib-de-fornecedor');\n" }, { denylist: [...DEFAULT_SDK_DENYLIST, 'minha-lib-de-fornecedor'] })), ['ARCH_SDK_OUTSIDE_ADAPTER']);
});

test('arquitetura_http_externo_apenas_via_client', () => {
  const r = scan({
    'features/a/a.js': "const axios = require('axios');\n",
    'features/a/b.js': "const f = require('node-fetch');\nconst g = require('got');\n",
    'features/a/c.js': "const r = await fetch('https://x.example');\n",
    'features/a/d.js': "const r = await globalThis.fetch('https://x.example');\n",
    'features/a/e.js': "const https = require('node:https');\n",
    'features/a/f.js': "const { resilientFetch } = require('../../utils/resilientFetch');\n",
    'features/a/ok.js': "const r = await httpClient.fetch('https://x.example'); // fetch( em comentário não conta\n",
    'features/integrations/http/IntegrationHttpClient.js': "const https = require('https');\nconst { resilientFetch } = require('../../../utils/resilientFetch');\n",
    'utils/resilientFetch.js': 'const r = await fetch(url);\n',
    'features/integrations/providers/bank/x/x.adapter.js': "const axios = require('axios');\n",
  });
  assert.deepEqual(r.map((x) => `${x.code}:${x.file}`), [
    'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/a.js', 'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/b.js', 'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/b.js',
    'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/c.js', 'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/d.js', 'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/e.js',
    'ARCH_HTTP_OUTSIDE_CLIENT:src/features/a/f.js', 'ARCH_HTTP_OUTSIDE_CLIENT:src/features/integrations/providers/bank/x/x.adapter.js',
  ], 'nem o adapter pode usar biblioteca HTTP: tudo passa pelo cliente único');
});

test('arquitetura_features_nao_importam_providers', () => {
  const r = scan({
    'features/crm/a.js': "const x = require('../integrations/providers/bank/bank.port');\n",
    'features/crm/b.js': "const x = require('../integrations');\nconst y = require('../integrations/index');\n",
    'features/integrations/index.js': "module.exports = {};\n",
    'features/integrations/registry/r.js': "const x = require('../providers/bank/bank.port');\n",
    'features/ai/providers/m.js': "const { IntegrationAdapter } = require('../../integrations');\n",
    'features/ai/providers/n.js': "const { IntegrationAdapter } = require('../../integrations/registry/IntegrationAdapter');\n",
    'features/ai/providers/o.js': "const p = require('../../integrations/providers/ai/ai.port');\n",
  });
  assert.deepEqual(r.map((x) => `${x.code}:${x.file}`), [
    'ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL:src/features/ai/providers/n.js',
    'ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL:src/features/ai/providers/o.js',
    'ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL:src/features/ai/providers/o.js',
    'ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL:src/features/crm/a.js',
  ], 'fora do módulo só o index.js; dentro dele, registry importa providers sem problema');
});

test('arquitetura_providers_nao_importam_features', () => {
  const r = scan({
    'features/integrations/providers/bank/bank.port.js': "const { x } = require('../../registry/IntegrationAdapter');\n",
    'features/integrations/providers/bank/acme/acme.adapter.js': [
      "const a = require('../bank.port');", "const b = require('../../../registry/IntegrationAdapter');", "const c = require('../../../http/IntegrationHttpClient');",
      "const d = require('../../../secrets');", "const e = require('../../../../crm/person.service');", "const f = require('../../messaging/messaging.port');",
      "const g = require('../../../dispatch/dispatch.create');", "const h = require('../../../../../models');", '',
    ].join('\n'),
  });
  assert.deepEqual(r.map((x) => `${x.code}:${x.line}`), ['ARCH_PROVIDER_IMPORTS_DOMAIN:5', 'ARCH_PROVIDER_IMPORTS_DOMAIN:6', 'ARCH_PROVIDER_IMPORTS_DOMAIN:7', 'ARCH_PROVIDER_IMPORTS_DOMAIN:8']);
});

test('arquitetura_violacao_sintetica_e_detectada', () => {
  const f = criarFixture({ 'features/crm/ruim.js': "const twilio = require('twilio');\nconst r = await fetch('https://x');\n" });
  try {
    const run = spawnSync(process.execPath, [path.join(API_ROOT, 'scripts/checkIntegrationBoundaries.js'), '--raiz', f.srcRoot], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'o portão reprova');
    assert.match(run.stderr, /2 violação\(ões\)/);
    assert.match(run.stderr, /ruim\.js:1 \[ARCH_SDK_OUTSIDE_ADAPTER\] Pacote de fornecedor importado fora de um adaptador\./);
    assert.match(run.stderr, /ruim\.js:2 \[ARCH_HTTP_OUTSIDE_CLIENT\]/);
  } finally { f.limpar(); }
  const limpo = spawnSync(process.execPath, [path.join(API_ROOT, 'scripts/checkIntegrationBoundaries.js')], { encoding: 'utf8' });
  assert.equal(limpo.status, 0, limpo.stderr);
  assert.match(limpo.stdout, /0 violações/);
});

test('arquitetura_sdk_de_ia_so_em_ai_providers', () => {
  const r = scan({
    'features/ai/providers/openai/openai.adapter.js': "const OpenAI = require('openai');\n",
    'features/ai/providers/anthropic/a.js': "const { Anthropic } = require('@anthropic-ai/sdk');\n",
    'features/ai/agents/a.js': "const OpenAI = require('openai');\n",
    'features/integrations/registry/r.js': "const OpenAI = require('openai');\n",
    'features/integrations/providers/ai/ai.port.js': "const A = require('@anthropic-ai/sdk');\n",
    'features/crm/c.js': "const g = require('@google/generative-ai');\n",
  });
  assert.deepEqual(r.map((x) => `${x.code}:${x.file}`), [
    'ARCH_SDK_OUTSIDE_ADAPTER:src/features/ai/agents/a.js',
    'ARCH_SDK_OUTSIDE_ADAPTER:src/features/crm/c.js',
    'ARCH_SDK_OUTSIDE_ADAPTER:src/features/integrations/providers/ai/ai.port.js',
    'ARCH_SDK_OUTSIDE_ADAPTER:src/features/integrations/registry/r.js',
  ], 'o SDK de modelo é aceito só em ai/providers; em qualquer outro lugar, inclusive em integrations, é recusado');
});
