'use strict';

// Contrato ÚNICO dos adapters de modelo (M9-D010): o mesmo conjunto de verificações roda contra o sandbox e contra os adapters
// reais falando com o servidor falso. Cada caso entrega `make()` (adapter novo, conexão nova), o modelo de geração, o de
// embedding (ou null) e os marcadores que provocam cada tipo de falha.
const assert = require('node:assert/strict');
const { AiProviderError, KINDS } = require('../../../src/features/ai/providers/providers.errors');
const { FINISH_REASONS } = require('../../../src/features/ai/providers/AIProviderAdapter');

const OPERACOES = ['generate', 'embed', 'transcribe', 'analyzeImage'];
const SEIS_CASAS = /^\d+\.\d{6}$/;
const pedido = (model, texto, extra = {}) => ({ model, system: 'Você é a NAY.', messages: [{ role: 'user', content: texto }], maxOutputTokens: 256, temperature: 0, timeoutMs: 1500, correlationId: 'c-1', idempotencyKey: 'k-1', ...extra });

function assertGenerateShape(r) {
  assert.equal(typeof r.text, 'string');
  assert.ok(Array.isArray(r.toolRequests));
  r.toolRequests.forEach((t) => { assert.equal(typeof t.name, 'string'); assert.equal(typeof t.arguments, 'object'); });
  assert.ok(Number.isInteger(r.usage.tokensIn) && Number.isInteger(r.usage.tokensOut));
  assert.match(r.costAmount, SEIS_CASAS);
  assert.ok(FINISH_REASONS.includes(r.finishReason), r.finishReason);
  assert.ok(typeof r.providerRequestId === 'string' && r.providerRequestId.length > 0);
  assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
}

function assertEmbedShape(r, n) {
  assert.equal(r.vectors.length, n);
  assert.ok(r.dimensions > 0);
  r.vectors.forEach((v) => { assert.equal(v.length, r.dimensions); v.forEach((x) => assert.equal(typeof x, 'number')); });
  assert.ok(Number.isInteger(r.usage.tokensIn));
}

/** Verificações de forma + capacidades + catálogo de UM adapter. */
async function assertContract(c) {
  const adapter = c.make();
  const caps = adapter.capabilities();
  assert.ok(Array.isArray(caps) && caps.length > 0 && caps.every((x) => typeof x === 'string' && OPERACOES.includes(x)), `${c.name}: capabilities é lista de strings`);
  assert.deepEqual(adapter.catalogProblems(), [], `${c.name}: catálogo de modelos`);
  adapter.models().forEach((m) => { assert.ok(['SMALL', 'ADVANCED', 'EMBEDDING'].includes(m.classe)); assert.ok([1, 2, 3].includes(m.safetyTier)); });
  assertGenerateShape(await c.make().generate(pedido(c.genModel, 'Olá')));
  if (c.embedModel) {
    assertEmbedShape(await c.make().embed({ model: c.embedModel, inputs: ['a', 'bb', 'ccc'] }), 3);
  }
  for (const op of OPERACOES.filter((o) => !caps.includes(o))) {
    assert.throws(() => c.make()[op]({ model: c.genModel }), (e) => e.code === 'AI_CAPABILITY_UNSUPPORTED' && e.statusCode === 501 && e.message === 'O provedor não suporta esta capacidade.', `${c.name}: ${op}`);
  }
}

/** Cada falha do fornecedor sai como AiProviderError do tipo certo, com `retryable` coerente. */
async function assertNormalizedErrors(c) {
  const esperado = { AUTH: false, VALIDATION: false, RATE_LIMIT: true, UNAVAILABLE: true };
  for (const [kind, retryable] of Object.entries(esperado)) {
    const err = await c.make().generate(pedido(c.genModel, c.marker(kind))).then(() => null, (e) => e);
    assert.ok(err instanceof AiProviderError, `${c.name}/${kind}: AiProviderError`);
    assert.equal(err.kind, kind, `${c.name}/${kind}`);
    assert.equal(err.retryable, retryable, `${c.name}/${kind} retryable`);
    assert.ok(KINDS.includes(err.kind));
  }
}

module.exports = { assertContract, assertNormalizedErrors, assertGenerateShape, assertEmbedShape, pedido, SEIS_CASAS, OPERACOES };
