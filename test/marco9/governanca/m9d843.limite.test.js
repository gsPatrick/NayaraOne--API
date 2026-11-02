'use strict';

// M9-D843 — limite de requisições por credencial pela API real (banco descartável): cabeçalhos, 429 com Retry-After, isolamento, contador compartilhado entre processos e limite por IP.
process.env.PORT = process.env.M9D843_LIMITE_TEST_PORT || '21843';
process.env.API_RATE_LIMIT_ENABLED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d843Env');

const LIMIT = 'governanca.api.rate_limit.interno_por_minuto';
let http;
let A;
let B;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const ping = (who) => http.call(who, 'GET', '/auth/companies');
const userKey = (tenant, userId) => `u:${tenant.companyId}:${userId}`;

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A, B } = await env.loadTenants());
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], gestorB: ['B', 'gestor'] } });
});
after(async () => { if (env.DISPOSABLE) { await env.clearSettings(LIMIT); await env.resetCounters(); } await stopHttp({}); });

test('m9d843 601ª chamada devolve 429 com Retry-After', { skip: skip() }, async () => {
  await env.setSetting(A, LIMIT, 600);
  await env.resetCounters();
  let last;
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    await env.resetCounters();
    await env.waitSafeWindow(4);
    const janela = await env.windowStart();
    for (let i = 1; i <= 600; i += 1) {
      last = await ping('gestorA');
      assert.equal(last.status, 200, `chamada ${i}`);
    }
    // sob carga a sequência pode cruzar a virada do minuto: se a janela mudou, o contador reiniciou e a sequência é refeita
    if ((await env.windowStart()) === janela) break;
  }
  assert.deepEqual([last.headers.get('x-ratelimit-limit'), last.headers.get('x-ratelimit-remaining')], ['600', '0'], 'cabeçalhos na 600ª');
  assert.ok(Number(last.headers.get('x-ratelimit-reset')) > Date.now() / 1000 - 1, 'X-RateLimit-Reset em epoch');
  const blocked = await ping('gestorA');
  assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, 'GOV_RATE_LIMITED');
  const retry = Number(blocked.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 60, `Retry-After ${retry}`);
  assert.equal(blocked.body.error.message, `Muitas requisições. Tente novamente em ${retry} segundos.`);
  assert.ok(blocked.body.error.traceId, 'error.traceId');
  assert.equal(blocked.headers.get('x-ratelimit-remaining'), '0');
});

test('m9d843 limites são por credencial e isolados entre empresas', { skip: skip() }, async () => {
  const other = await ping('makerA');
  assert.equal(other.status, 200, 'outro usuário da mesma empresa não é afetado');
  assert.equal(Number(other.headers.get('x-ratelimit-limit')), 600, 'o limite é o da empresa A');
  const rival = await ping('gestorB');
  assert.equal(rival.status, 200, 'a outra empresa não é afetada');
  assert.equal(Number(rival.headers.get('x-ratelimit-limit')), 1200, 'empresa B segue o padrão do catálogo');
  assert.equal((await ping('gestorA')).status, 429, 'a credencial excedida segue limitada');
  assert.equal(await env.countOf(userKey(B, B.userId)), 1);
});

test('m9d843 dois processos somam no mesmo contador: 300 + 301 chamadas, a 601ª devolve 429', { skip: skip() }, async () => {
  await env.resetCounters();
  await env.waitSafeWindow(4);
  const key = userKey(A, A.userId);
  const run = (n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../_helpers/m9d843Hits.js'), key, String(n)], { env: { ...process.env, LOG_LEVEL: 'silent' } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop()).last) : reject(new Error(`filho saiu com ${code}`))));
  });
  const lasts = await Promise.all([run(300), run(301)]);
  assert.equal(Math.max(...lasts), 601, 'o maior valor visto pelos dois processos é a soma');
  assert.equal(await env.countOf(key), 601);
  const next = await ping('gestorA');
  assert.equal(next.status, 429, 'a chamada seguinte (602ª) já passa do limite de 600');
});

test('m9d843 rota sem credencial é limitada por IP', { skip: skip() }, async () => {
  await env.resetCounters();
  await env.waitSafeWindow(4);
  const call = () => fetch(`${http.baseUrl}/crm/carts/public/token-que-nao-existe`);
  let res;
  for (let i = 1; i <= 60; i += 1) {
    res = await call();
    assert.notEqual(res.status, 429, `chamada ${i}`);
  }
  assert.equal(res.headers.get('x-ratelimit-limit'), '60', 'limite anônimo do catálogo');
  const blocked = await call();
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'GOV_RATE_LIMITED');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('m9d843 o administrador desliga o limite da empresa', { skip: skip() }, async () => {
  await env.setSetting(A, 'governanca.api.rate_limit.habilitado', false);
  try {
    const res = await ping('gestorA');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-ratelimit-limit'), null, 'sem limite, sem cabeçalho');
  } finally { await env.clearSettings('governanca.api.rate_limit.habilitado'); }
});
