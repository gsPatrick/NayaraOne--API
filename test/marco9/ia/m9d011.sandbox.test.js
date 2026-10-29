'use strict';

// M9-D011 — provider sandbox determinístico: mesma entrada, mesma saída; fixtures; embed estável; nunca faz rede. Sem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { SandboxAdapter } = require('../../../src/features/ai/providers/sandbox/SandboxAdapter');
const { sandboxGenerate } = require('../../../src/features/ai/providers/sandbox/sandboxGenerate');
const { microsToAmount } = require('../../../src/features/ai/providers/providers.cost');
const { pedido, assertGenerateShape } = require('../_helpers/iaAdapterContract');

const sb = () => new SandboxAdapter(null);
const gerar = (texto, extra) => sb().generate(pedido('sandbox-1', texto, extra));
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

test('m9d011_sandbox_deterministico_mesma_entrada_mesma_saida', async () => {
  const a = await gerar('Qual o saldo?');
  const b = await gerar('Qual o saldo?');
  assert.deepEqual(a, b);
  assertGenerateShape(a);
  assert.notEqual((await gerar('Outra pergunta')).text, a.text);
  const comOutroSystem = await sb().generate({ ...pedido('sandbox-1', 'Qual o saldo?'), system: 'outro' });
  assert.notEqual(comOutroSystem.text, a.text, 'a resposta depende de system + mensagens');
  // [[ECO]] olá -> "olá", custo fixo de teste (tokens x preço fixo).
  const eco = await gerar('[[ECO]] olá');
  assert.equal(eco.text, 'olá');
  assert.equal(eco.costAmount, microsToAmount(eco.usage.tokensIn * 2 + eco.usage.tokensOut * 6));
  assert.deepEqual(await gerar('[[ECO]] olá'), eco);
  // [[JSON:{...}]] devolve o JSON; [[TOOL:nome:{args}]] devolve um toolRequest; [[CUSTO:valor]] define o custo.
  const js = await gerar('[[JSON:{"ok":true,"n":[1,2]}]]');
  assert.deepEqual(JSON.parse(js.text), { ok: true, n: [1, 2] });
  const tool = await gerar('[[TOOL:crm.getOpportunity:{"id":"7"}]]');
  assert.deepEqual(tool.toolRequests, [{ name: 'crm.getOpportunity', arguments: { id: '7' } }]);
  assert.equal(tool.finishReason, 'tool_calls');
  const custo = await gerar('[[ECO]] x [[CUSTO:12.5]]');
  assert.equal(custo.costAmount, '12.500000');
  assert.equal(sandboxGenerate({ messages: [{ role: 'user', content: '[[ECO]] oi' }] }).providerCode, 'ai-sandbox');
});

test('m9d011_sandbox_fixtures_de_falha', async () => {
  const falha = (texto, extra) => gerar(texto, extra).then(() => null, (e) => e);
  for (const [kind, retryable] of [['TIMEOUT', true], ['RATE_LIMIT', true], ['UNAVAILABLE', true], ['AUTH', false], ['VALIDATION', false]]) {
    const e = await falha(`[[FALHA:${kind}]]`);
    assert.equal(e.kind, kind);
    assert.equal(e.retryable, retryable);
    assert.equal(e.name, 'AiProviderError');
  }
  // [[LENTO:ms]] simula a latência: dentro do limite responde com ela, acima vira TIMEOUT retryable (sem dormir).
  const inicio = Date.now();
  assert.equal((await gerar('[[LENTO:400]] oi', { timeoutMs: 1000 })).latencyMs, 400);
  const e = await falha('[[LENTO:5000]] oi', { timeoutMs: 1000 });
  assert.equal(e.kind, 'TIMEOUT');
  assert.ok(Date.now() - inicio < 500, 'nenhuma espera real');
  assert.equal((await falha('[[FALHA:INEXISTENTE]] oi')), null, 'marcador desconhecido não vira falha');
});

test('m9d011_sandbox_embed_estavel', async () => {
  const a = await sb().embed({ model: 'sandbox-embed-1', inputs: ['contrato de locação', 'contrato de locacao residencial', 'receita de bolo de cenoura'] });
  const b = await sb().embed({ model: 'sandbox-embed-1', inputs: ['contrato de locação'] });
  assert.equal(a.dimensions, 64);
  assert.ok(a.vectors.every((v) => v.length === 64));
  assert.deepEqual(a.vectors[0], b.vectors[0], 'textos iguais, vetores iguais');
  // Textos parecidos (n-gramas em comum) ficam mais próximos que textos sem relação.
  assert.ok(cos(a.vectors[0], a.vectors[1]) > cos(a.vectors[0], a.vectors[2]) + 0.2);
  const norma = Math.sqrt(cos(a.vectors[0], a.vectors[0]));
  assert.ok(Math.abs(norma - 1) < 1e-4, 'vetor normalizado');
  assert.deepEqual((await sb().embed({ model: 'sandbox-embed-1', inputs: [''] })).vectors[0].length, 64);
  // transcribe e analyzeImage também são determinísticos (declarados para os testes de capacidade).
  const t = await sb().transcribe({ model: 'sandbox-media-1', fileRef: 'files/audio-1', language: 'pt-BR' });
  assert.deepEqual(t, await sb().transcribe({ model: 'sandbox-media-1', fileRef: 'files/audio-1', language: 'pt-BR' }));
  const im = await sb().analyzeImage({ model: 'sandbox-media-1', imageRef: 'files/img-1', prompt: 'descreva' });
  assert.deepEqual(im, await sb().analyzeImage({ model: 'sandbox-media-1', imageRef: 'files/img-1', prompt: 'descreva' }));
  assert.match(im.costAmount, /^\d+\.\d{6}$/);
});

test('m9d011_sandbox_nao_acessa_rede', async () => {
  const chamadas = [];
  const guarda = (obj, nome) => { const orig = obj[nome]; obj[nome] = () => { chamadas.push(nome); throw new Error(`rede proibida: ${nome}`); }; return () => { obj[nome] = orig; }; };
  const restaurar = [
    guarda(globalThis, 'fetch'), guarda(http, 'request'), guarda(http, 'get'), guarda(https, 'request'), guarda(https, 'get'),
    guarda(net.Socket.prototype, 'connect'), guarda(net, 'connect'), guarda(dns, 'lookup'),
  ];
  try {
    const a = sb();
    await a.generate(pedido('sandbox-1', '[[ECO]] oi'));
    await a.embed({ model: 'sandbox-embed-1', inputs: ['x'] });
    await a.transcribe({ model: 'sandbox-media-1', fileRef: 'f' });
    await a.analyzeImage({ model: 'sandbox-media-1', imageRef: 'i', prompt: 'p' });
    assert.deepEqual(await a.healthCheck(), { ok: true, latencyMs: 0, detail: 'Provedor de testes: sem rede.' });
  } finally { restaurar.reverse().forEach((r) => r()); }
  assert.deepEqual(chamadas, []);
  // O sandbox nem recebe cliente HTTP: sem ctx, ele não teria como chamar.
  assert.equal(new SandboxAdapter(null).ctx, null);
});
