'use strict';

// M9-D010 — erros normalizados (AiProviderError), AUTH/VALIDATION sem reenvio (INT-006), timeout e credencial fora do erro.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { startProviderServer } = require('../_helpers/iaProviderServer');
const { casosDeContrato, HTTP } = require('../_helpers/iaAdapterCases');
const { assertNormalizedErrors, pedido } = require('../_helpers/iaAdapterContract');
const { realCtx, SEGREDO } = require('../_helpers/iaAdapterCtx');
const { OpenAIAdapter } = require('../../../src/features/ai/providers/openai/OpenAIAdapter');
const { AnthropicAdapter } = require('../../../src/features/ai/providers/anthropic/AnthropicAdapter');
const { AiProviderError } = require('../../../src/features/ai/providers/providers.errors');
const { normalizeProviderError } = require('../../../src/features/ai/providers/normalizeError');

let srv;
let casos;
before(async () => { srv = await startProviderServer(); casos = casosDeContrato(srv.baseUrl); });
after(async () => { await srv.close(); });

const chamar = (a, texto, extra) => a.generate(pedido('m-gen', texto, extra)).then(() => null, (e) => e);

test('m9d010_erro_normalizado_em_todos_os_adapters', async () => {
  for (const c of casos) await assertNormalizedErrors(c);
  // Fixtures do sandbox que não têm par HTTP.
  const sb = casos[0].make();
  const seg = await sb.generate(pedido('sandbox-1', '[[FALHA:SAFETY_BLOCKED]]')).then(() => null, (e) => e);
  assert.equal(seg.kind, 'SAFETY_BLOCKED');
  // Recusa de segurança do fornecedor real.
  for (const A of [[OpenAIAdapter, 'openai'], [AnthropicAdapter, 'anthropic']]) {
    const e = await chamar(new A[0](realCtx(A[1], srv.baseUrl)), '[[SAFETY]]');
    assert.equal(e.kind, 'SAFETY_BLOCKED');
    assert.equal(e.retryable, false);
  }
});

test('m9d010_mensagens_e_codigos_http_do_livro', async () => {
  const oa = () => new OpenAIAdapter(realCtx('openai', srv.baseUrl));
  const auth = await chamar(oa(), `[[HTTP:${HTTP.AUTH}]]`);
  assert.deepEqual([auth.statusCode, auth.code, auth.message], [502, 'AI_PROVIDER_AUTH', 'O provedor recusou a credencial configurada.']);
  const fora = await chamar(oa(), `[[HTTP:${HTTP.UNAVAILABLE}]]`);
  assert.deepEqual([fora.statusCode, fora.code, fora.message], [503, 'AI_PROVIDER_UNAVAILABLE', 'O provedor de IA está indisponível no momento.']);
});

test('m9d010_erro_auth_nao_e_reenviado', async () => {
  // INT-006: 401 e 400 vão ao fornecedor UMA vez; erro transitório (503) é repetido pelo cliente HTTP único.
  const antes = srv.hits['/v1/chat/completions'] || 0;
  const a = await chamar(new OpenAIAdapter(realCtx('openai', srv.baseUrl)), '[[HTTP:401]]');
  assert.equal(a.kind, 'AUTH');
  assert.equal(srv.hits['/v1/chat/completions'] - antes, 1, 'AUTH: uma única chamada');
  const v = await chamar(new OpenAIAdapter(realCtx('openai', srv.baseUrl)), '[[HTTP:400]]');
  assert.equal(v.kind, 'VALIDATION');
  assert.equal(srv.hits['/v1/chat/completions'] - antes, 2, 'VALIDATION: mais uma única chamada');
  const u = await chamar(new OpenAIAdapter(realCtx('openai', srv.baseUrl)), '[[HTTP:503]]');
  assert.equal(u.kind, 'UNAVAILABLE');
  assert.equal(srv.hits['/v1/chat/completions'] - antes, 2 + 3, 'UNAVAILABLE: repetido até o limite do cliente');
  assert.equal(u.retryable, true);
  assert.equal(a.retryable, false);
  assert.equal(v.retryable, false);
});

test('m9d010_timeout_respeitado', async () => {
  for (const c of casos) {
    const inicio = Date.now();
    const e = await c.make().generate(pedido(c.genModel, c.slow(3000), { timeoutMs: 150 })).then(() => null, (x) => x);
    assert.ok(e instanceof AiProviderError, c.name);
    assert.equal(e.kind, 'TIMEOUT', c.name);
    assert.equal(e.retryable, true);
    assert.equal(e.statusCode, 504);
    // O limite do pedido (150 ms) vale por tentativa: bem antes dos 3 s do fornecedor lento.
    assert.ok(Date.now() - inicio < 2900, `${c.name}: ${Date.now() - inicio} ms`);
  }
  // Dentro do limite responde normalmente.
  const ok = await casos[0].make().generate(pedido('sandbox-1', '[[LENTO:50]] oi', { timeoutMs: 150 }));
  assert.equal(ok.latencyMs, 50);
});

test('m9d010_credencial_nao_vaza_em_erro', async () => {
  for (const [A, code] of [[OpenAIAdapter, 'openai'], [AnthropicAdapter, 'anthropic']]) {
    const adapter = new A(realCtx(code, srv.baseUrl));
    const req = pedido('m-gen', '[[ECHO_KEY]]');
    const e = await chamar(adapter, '[[ECHO_KEY]]');
    assert.equal(e.kind, 'AUTH');
    // O fornecedor chegou a ecoar a chave no corpo do erro; nada disso pode aparecer no erro, no log ou no objeto.
    const tudo = [e.message, JSON.stringify(e), util.inspect(e, { depth: 6 }), e.stack, util.inspect(adapter, { depth: 8 }), JSON.stringify(req)].join('\n');
    assert.ok(!tudo.includes(SEGREDO), `${code}: a credencial apareceu`);
    assert.ok(!tudo.includes('invalid api key'), `${code}: texto do fornecedor não passa`);
  }
  // A credencial foi mesmo enviada ao fornecedor (cabeçalho), só não fica em lugar nenhum nosso.
  assert.ok(String(srv.server.lastHeaders['x-api-key'] || srv.server.lastHeaders.authorization).includes(SEGREDO));
  // Sem segredo configurado: erro AUTH de configuração, sem tentar a rede.
  const sem = new OpenAIAdapter(realCtx('openai', srv.baseUrl, { secret: null }));
  const antes = srv.hits['/v1/chat/completions'] || 0;
  const e = await chamar(sem, 'oi');
  assert.deepEqual([e.kind, e.code, e.statusCode], ['AUTH', 'AI_PROVIDER_NOT_CONFIGURED', 400]);
  assert.equal(srv.hits['/v1/chat/completions'] || 0, antes);
});

test('m9d010_normalizeProviderError_classifica_rede_e_circuito', () => {
  const k = (err) => normalizeProviderError(err, { providerCode: 'x' });
  assert.equal(k({ code: 'TIMEOUT' }).kind, 'TIMEOUT');
  assert.equal(k({ name: 'AbortError' }).kind, 'TIMEOUT');
  assert.equal(k({ code: 'ECONNREFUSED' }).kind, 'UNAVAILABLE');
  assert.equal(k({ code: 'CIRCUIT_OPEN', message: 'segredo sk-123' }).kind, 'UNAVAILABLE');
  assert.equal(k({ status: 429 }).kind, 'RATE_LIMIT');
  assert.equal(k({ status: 403 }).kind, 'AUTH');
  assert.equal(k({ status: 422 }).kind, 'VALIDATION');
  assert.equal(k(new Error('algo estranho sk-123')).kind, 'UNKNOWN');
  assert.ok(!JSON.stringify(k(new Error('algo estranho sk-123'))).includes('sk-123'));
  const ja = new AiProviderError('AUTH');
  assert.equal(k(ja), ja);
});
