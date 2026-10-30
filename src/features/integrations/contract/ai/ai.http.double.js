'use strict';

/**
 * "Fornecedor" HTTP de modelo dos contract tests dos adapters de IA (M9-D011 + M9-D222): o `ctx.http` que o adapter real usa, sem rede. As respostas de sucesso vêm da
 * FIXTURE (`wire.<operação>.ok`, no formato do próprio fornecedor), então nenhum conhecimento de fornecedor mora aqui. A falha é injetada por pedido (`fault`):
 *   { kind: 'status', status, retryAfter? } | { kind: 'timeout', afterMs } | { kind: 'truncated' } | { kind: 'mutate', how: 'missing' | 'wrongType', field } | { kind: 'overrideOk', patch }
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const clone = (v) => JSON.parse(JSON.stringify(v));

function answer(status, body, headers = {}) {
  const baixo = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => baixo[String(n).toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function mutate(body, { how, field }) {
  const c = clone(body);
  if (how === 'missing') delete c[field];
  else c[field] = 12345;
  return c;
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch (e) { return String(url); }
}

/** { http, calls }: `calls` guarda cada pedido recebido (url, cabeçalhos, corpo) para o cenário de duplicidade. */
function makeAiHttpDouble(wire, fault) {
  const calls = [];
  const http = {
    async request({ method = 'GET', url, headers = {}, body }) {
      calls.push({ method, path: pathOf(url), headers: { ...headers }, body: body ? JSON.parse(body) : null });
      if (fault && fault.kind === 'status') return answer(fault.status, { error: { type: 'contract' } }, fault.retryAfter ? { 'retry-after': fault.retryAfter } : {});
      if (fault && fault.kind === 'timeout') {
        await sleep(fault.afterMs);
        throw Object.assign(new Error('Tempo esgotado esperando o fornecedor.'), { code: 'ETIMEDOUT', name: 'TimeoutError' });
      }
      const alvo = Object.values(wire).find((w) => w && w.path === pathOf(url));
      if (!alvo) return answer(404, { error: { type: 'not_found' } });
      if (fault && fault.kind === 'truncated') return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse('{"id":"x"'), text: async () => '{"id":"x"' };
      let ok = fault && fault.kind === 'mutate' ? mutate(alvo.ok, fault) : clone(alvo.ok);
      if (fault && fault.kind === 'overrideOk') ok = { ...ok, ...fault.patch };
      return answer(200, ok);
    },
  };
  return { http, calls };
}

module.exports = { makeAiHttpDouble };
