'use strict';

// M9-D010 — todo HTTP de adapter de IA passa pelo IntegrationHttpClient; nenhum SDK/HTTP de fornecedor fora de providers/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AIProviderAdapter } = require('../../../src/features/ai/providers/AIProviderAdapter');
const { IntegrationAdapter } = require('../../../src/features/integrations/registry/IntegrationAdapter');
const { varrer, varrerSdkFornecedorNoRestoDoCodigo, limparComentarios } = require('../../../scripts/lib/aiArchGuard');

const RAIZ = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai', 'providers');

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('m9d010_http_somente_pelo_integration_http_client', () => {
  assert.ok(AIProviderAdapter.prototype instanceof IntegrationAdapter);
  const proibidos = [
    /(?<![\w.$])fetch\s*\(/, /require\(\s*['"](?:node:)?https?['"]\s*\)/, /require\(\s*['"](?:axios|node-fetch|undici|got|superagent|request)['"]\s*\)/,
    /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\b/, /require\(\s*['"](?:node:)?net['"]\s*\)/, /require\(\s*['"].*resilientFetch['"]\s*\)/,
  ];
  const lista = arquivos(RAIZ);
  assert.ok(lista.length >= 15, 'varreu a pasta toda');
  for (const f of lista) {
    const codigo = limparComentarios(fs.readFileSync(f, 'utf8'));
    proibidos.forEach((re) => assert.ok(!re.test(codigo), `${path.relative(RAIZ, f)} usa HTTP fora do cliente único (${re})`));
  }
  // O adapter real chama pelo cliente do ctx.
  const base = limparComentarios(fs.readFileSync(path.join(RAIZ, 'HttpModelAdapter.js'), 'utf8'));
  assert.ok(/this\.ctx\.http\.request\(/.test(base));
  // Os adapters de fornecedor não falam HTTP: usam postJson da base.
  for (const sub of ['anthropic/AnthropicAdapter.js', 'openai/OpenAIAdapter.js']) {
    const codigo = limparComentarios(fs.readFileSync(path.join(RAIZ, sub), 'utf8'));
    assert.ok(/this\.postJson\(/.test(codigo) && !/\bhttp\b/.test(codigo.replace(/\/\/.*$/gm, '')), sub);
  }
});

test('m9d010_nenhum_sdk_http_de_fornecedor_fora_de_providers', () => {
  assert.deepEqual(varrer().map((v) => `${v.arquivo}:${v.linha}`), []);
  assert.deepEqual(varrerSdkFornecedorNoRestoDoCodigo().map((v) => `${v.arquivo}:${v.linha}`), []);
  // Os hosts dos fornecedores existem só dentro de providers/.
  const hosts = /api\.(?:openai|anthropic)\.com/;
  const srcRaiz = path.join(RAIZ, '..', '..', '..');
  const fora = [];
  (function andar(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p !== RAIZ) andar(p); } else if (p.endsWith('.js') && hosts.test(limparComentarios(fs.readFileSync(p, 'utf8')))) fora.push(path.relative(srcRaiz, p));
    });
  }(srcRaiz));
  assert.deepEqual(fora, []);
});
