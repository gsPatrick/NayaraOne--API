'use strict';

// Marco 9, M9-D209 — arquitetura (HTTP só pelo cliente único), adapters existentes sob o contrato, redação.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sequelize } = require('../../testHelpers');
const { IntegrationAdapter } = require('../../../src/features/integrations/registry/IntegrationAdapter');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { registerBuiltInAdapters, BUILT_IN_ADAPTERS } = require('../../../src/features/integrations/adapters');
const { SandboxFinancingProviderAdapter } = require('../../../src/features/correspondent/adapters/FinancingProviderAdapter');

after(async () => { await sequelize.close(); });
const SRC = path.join(__dirname, '..', '..', '..', 'src');

function arquivos(dir, acumulado = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acumulado);
    else if (p.endsWith('.js')) acumulado.push(p);
  });
  return acumulado;
}

test('adapter_http_somente_pelo_client', async () => {
  // Todo arquivo de adapter (qualquer pasta "adapters", os ports, o registro e os wrappers) fala HTTP só pelo cliente único.
  // O adapter bancário do Financeiro mora em src/modules/finance/infrastructure/bank (Guia do Marco 4, §2): porta, provedores e hub.
  const alvo = [...arquivos(path.join(SRC, 'features')), ...arquivos(path.join(SRC, 'modules'))].filter((f) => {
    const rel = f.split(path.sep).join('/');
    if (rel.includes('/integrations/http/')) return false;
    return /\/adapters\//.test(rel) || /\/integrations\/(providers|registry|adapters)\//.test(rel) || /\/finance\/infrastructure\/bank\//.test(rel);
  });
  assert.ok(alvo.length > 30, `varredura cobre os adapters (${alvo.length} arquivos)`);
  const proibido = [/(^|[^.\w])fetch\s*\(/, /axios/, /require\(['"](https?|node:https?|node-fetch|undici|got)['"]\)/, /resilientFetch/];
  const achados = [];
  alvo.forEach((f) => {
    fs.readFileSync(f, 'utf8').split('\n').forEach((linha, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(linha)) return;
      proibido.forEach((re) => { if (re.test(linha)) achados.push(`${path.relative(SRC, f)}:${i + 1}: ${linha.trim().slice(0, 90)}`); });
    });
  });
  assert.deepEqual(achados, [], 'chamada HTTP fora do IntegrationHttpClient');

  // O cliente: tempo por tipo de chamada, chave de circuito por fornecedor e passagem ao fetch com o mesmo contrato.
  const original = global.fetch;
  const chamadas = [];
  global.fetch = async (url, init) => { chamadas.push({ url, init }); return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }; };
  try {
    const c = new IntegrationHttpClient({ providerCode: 'qa', connectionId: 'c1', timeouts: { readMs: 1111, writeMs: 2222 } });
    assert.equal(c.timeoutFor('GET'), 1111);
    assert.equal(c.timeoutFor('POST'), 2222);
    assert.equal(c.circuitKey(), 'integration:qa:c1');
    await c.request({ method: 'GET', url: 'https://exemplo.invalid/a' });
    await c.fetch('https://exemplo.invalid/b', { method: 'POST', body: '{}' });
    assert.equal(chamadas.length, 2);
    assert.ok(chamadas.every((x) => x.init.signal), 'toda chamada leva tempo máximo');
    assert.equal(chamadas[1].init.method, 'POST');
  } finally { global.fetch = original; }
});

test('adapters_existentes_estendem_base_sem_regressao', async () => {
  registerBuiltInAdapters();
  const registrados = adapterRegistry.list().map((a) => a.providerCode);
  ['financing-sandbox', 'financing-manual', 'bank-sandbox', 'signature-sandbox', 'signature-clicksign', 'insurance-sandbox', 'fiscal-sandbox'].forEach((c) => assert.ok(registrados.includes(c), c));
  BUILT_IN_ADAPTERS.forEach((A) => assert.ok(new A(null) instanceof IntegrationAdapter, A.name));
  const por = (codigo) => new (BUILT_IN_ADAPTERS.find((A) => new A(null).providerCode() === codigo))({ connection: { id: 'c' }, secret: async () => { throw new Error('sem cofre'); } });

  // O comportamento é o do adapter antigo, só que sob o contrato (a bateria dos módulos roda inteira no registro de execução).
  const fin = por('financing-sandbox');
  const sub = await invoke(fin, 'submitCase', { idempotencyKey: 'k-209', amount: 1000 });
  const antigo = await new SandboxFinancingProviderAdapter().submitCase({ idempotencyKey: 'k-209', amount: 1000 });
  assert.equal(sub.externalResourceId, antigo.externalId, 'mesma submissão idempotente do adapter antigo');
  assert.equal(sub.status, 'SUBMITTED');
  assert.equal((await invoke(fin, 'getCaseStatus', { externalResourceId: sub.externalResourceId })).status, 'SUBMITTED');
  const segredo = 'wh-secret';
  const corpo = Buffer.from('{"a":1}');
  const assinado = { rawBody: corpo, headers: { 'x-webhook-signature': `sha256=${crypto.createHmac('sha256', segredo).update(corpo).digest('hex')}` }, secret: segredo };
  assert.equal((await invoke(fin, 'verifyWebhook', assinado)).status, 'VALID');
  assert.equal((await invoke(fin, 'verifyWebhook', { ...assinado, secret: 'outro' })).status, 'INVALID');
  assert.equal((await invoke(por('bank-sandbox'), 'verifyWebhook', assinado)).status, 'VALID');
  const manual = por('financing-manual');
  assert.equal((await invoke(manual, 'submitCase', { idempotencyKey: 'm-1' })).status, 'PENDING_MANUAL_ACTION');
  const env = await invoke(por('signature-sandbox'), 'createEnvelope', { documentRef: { id: 'd' }, signers: ['p1', 'p2'] });
  assert.ok(env.externalResourceId.startsWith('sbx-env-'), 'M9-D236: o sandbox de assinatura é um adapter do port, com ids determinísticos');
  assert.equal((await invoke(por('signature-sandbox'), 'getEnvelope', { externalResourceId: env.externalResourceId })).status, 'PENDING');
  assert.equal((await invoke(por('insurance-sandbox'), 'quote', { estimatedValue: 1000 })).status, 'COMPLETED');
  assert.equal((await invoke(por('insurance-sandbox'), 'propose', { idempotencyKey: 'p-1' })).status, 'ACTIVE');
  const nf = await invoke(por('fiscal-sandbox'), 'issueNfse', { idempotencyKey: 'n-1', serviceCode: '1.01' });
  assert.equal(nf.status, 'PROCESSING', 'a nota em processamento no emissor (estado do livro, M9-D241)');
  assert.equal((await invoke(por('fiscal-sandbox'), 'cancelNfse', { externalResourceId: nf.externalResourceId })).status, 'CANCELED');
  assert.equal((await invoke(por('bank-sandbox'), 'getStatement', {})).status, 'COMPLETED');
  // Erro do fornecedor classificado pelo adapter.
  assert.equal(fin.classifyError({ status: 429, retryAfterMs: 5000 }).class, 'RATE_LIMIT');
  assert.equal(fin.classifyError({ status: 401 }).class, 'AUTH');
  assert.equal(fin.classifyError({ status: 422 }).class, 'VALIDATION');
  assert.equal(fin.classifyError({ code: 'ETIMEDOUT' }).class, 'TRANSIENT');
  assert.equal(fin.classifyError({}).class, 'UNKNOWN');
});

test('adapter_redact_remove_segredo', () => {
  const a = new BUILT_IN_ADAPTERS[0](null);
  const saida = a.redact({
    token: 'abc123', authorization: 'Bearer xyz', senha: 'p4ss', apiKey: 'k-1', cpf: '529.982.247-25', email: 'fulano@exemplo.com',
    nome: 'Pagamento 10', valor: 100, aninhado: { clientSecret: 's3', ok: true },
  });
  const texto = JSON.stringify(saida);
  ['abc123', 'xyz', 'p4ss', 'k-1', '529.982.247-25', 'fulano@exemplo.com', 's3'].forEach((s) => assert.ok(!texto.includes(s), `vazou ${s}`));
  assert.equal(saida.nome, 'Pagamento 10');
  assert.equal(saida.valor, 100);
  assert.equal(a.redact(null), null);
});
