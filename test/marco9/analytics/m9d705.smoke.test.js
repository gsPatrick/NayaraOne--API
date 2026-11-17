'use strict';

// M9-D705 etapa 12 — o smoke do ambiente promovido (LAB = homologação publicada): login do usuário de teste somente leitura a cada execução (o
// token fixo expirava), DEV_SMOKE_TOKEN como alternativa, MFA reprova com mensagem clara, permissão faltando reprova dizendo qual e de qual
// painel, e senha e token nunca aparecem na saída. API falsa em 127.0.0.1 (nenhuma chamada à homologação).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { rodarSmoke, permissoesDoSmoke, ROTULO_ALVO } = require('../../../scripts/analytics/ci/smokeDev');
const { DASHBOARD_CATALOG } = require('../../../src/features/analytics/dashboards/dashboard.catalog');

const ROOT = path.join(__dirname, '..', '..', '..');
// valores fictícios montados em tempo de execução (a varredura de segredo do repositório não pode achá-los no arquivo)
const SENHA = ['senha', '-de-teste-', 'nao-imprimir'].join('');
const TOKEN = ['tok', 'en-de-teste-', 'nao-imprimir'].join('');
const REFRESH = ['ref', 'resh-de-teste'].join('');
const TODAS = permissoesDoSmoke().map((p) => p.permissao);

let server;
let base;
let cenario;
const chamadas = [];

before(async () => {
  server = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (d) => { corpo += d; });
    req.on('end', () => {
      chamadas.push({ metodo: req.method, url: req.url, auth: req.headers.authorization || null, corpo });
      const responder = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/api/v1/auth/login') return responder(...cenario.login(JSON.parse(corpo || '{}')));
      if (req.url === '/api/v1/auth/logout') return responder(200, { success: true, data: { revoked: true } });
      const m = /^\/api\/v1\/analytics\/dashboards\/([a-z_]+)$/.exec(req.url);
      if (m && req.headers.authorization === `Bearer ${TOKEN}`) return responder(...(cenario.painel ? cenario.painel(m[1]) : [200, { success: true, data: { dashboardCode: m[1] } }]));
      return responder(401, { success: false, error: { code: 'INVALID_TOKEN' } });
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => { server.close(); });

const loginOk = (extra = {}) => () => [200, { success: true, data: { accessToken: TOKEN, refreshToken: REFRESH, permissions: TODAS, ...extra } }];

async function rodar(env, sc) {
  cenario = sc;
  chamadas.length = 0;
  const linhas = [];
  let erro = null;
  let r = null;
  try { r = await rodarSmoke({ env, log: (l) => linhas.push(l) }); } catch (e) { erro = e; }
  const saida = `${linhas.join('\n')}\n${erro ? erro.message : ''}`;
  assert.doesNotMatch(saida, new RegExp(`${SENHA}|${TOKEN}|${REFRESH}`), 'senha e token nunca aparecem na saída');
  return { r, erro, saida };
}

const envLogin = () => ({ DEV_API_BASE_URL: `${base}/`, DEV_SMOKE_EMAIL: 'smoke-bi@nayaraone.dev', DEV_SMOKE_PASSWORD: SENHA });

test('m9d705 smoke faz login com o usuário de smoke, abre os 13 painéis com o token do login e encerra a sessão', async () => {
  const { r, saida } = await rodar(envLogin(), { login: (b) => (b.email === 'smoke-bi@nayaraone.dev' && b.password === SENHA ? loginOk()() : [401, { error: { code: 'INVALID_CREDENTIALS' } }]) });
  assert.equal(r.ok, true, saida);
  assert.equal(r.origem, 'login');
  assert.equal(r.total, DASHBOARD_CATALOG.length);
  const gets = chamadas.filter((c) => c.metodo === 'GET');
  assert.deepEqual(gets.map((c) => c.url), DASHBOARD_CATALOG.map((p) => `/api/v1/analytics/dashboards/${p.code}`));
  assert.ok(gets.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.equal(chamadas.at(-1).url, '/api/v1/auth/logout', 'a sessão aberta pelo login é encerrada');
  assert.match(saida, /LAB = homologação publicada/);
  assert.equal(ROTULO_ALVO.startsWith('LAB = homologação publicada'), true);
});

test('m9d705 smoke reprova com mensagem clara quando o login pede MFA', async () => {
  for (const login of [() => [403, { error: { code: 'MFA_STEP_UP_REQUIRED' } }], loginOk({ mfaSetupRequired: true }), () => [200, { data: { mfaRequired: true, challengeId: 'x' } }]]) {
    const { erro } = await rodar(envLogin(), { login });
    assert.ok(erro, 'reprova');
    assert.match(erro.message, /pediu MFA/);
    assert.equal(chamadas.filter((c) => c.metodo === 'GET').length, 0, 'nenhum painel é aberto sem a credencial');
  }
});

test('m9d705 smoke reprova dizendo a permissão e o painel quando o usuário não tem o que os painéis exigem', async () => {
  const semTech = TODAS.filter((p) => p !== 'analytics:read:tech');
  const { erro } = await rodar(envLogin(), { login: () => [200, { data: { accessToken: TOKEN, refreshToken: REFRESH, permissions: semTech } }] });
  assert.match(erro.message, /analytics:read:tech \(tech\)/);
  assert.equal(chamadas.at(-1).url, '/api/v1/auth/logout', 'mesmo reprovado, a sessão é encerrada');
});

test('m9d705 smoke reprova painel diferente de 200 e aceita DEV_SMOKE_TOKEN como alternativa ao login', async () => {
  const { r, saida } = await rodar({ DEV_API_BASE_URL: base, DEV_SMOKE_TOKEN: TOKEN }, { login: () => [500, {}], painel: (code) => (code === 'legal' ? [403, { error: { code: 'PERMISSION_DENIED' } }] : [200, { data: {} }]) });
  assert.equal(r.origem, 'DEV_SMOKE_TOKEN');
  assert.equal(r.ok, false);
  assert.equal(r.falhas, 1);
  assert.match(saida, /GET \/analytics\/dashboards\/legal: 403 PERMISSION_DENIED/);
  assert.equal(chamadas.some((c) => c.url.endsWith('/auth/login')), false, 'com o token não há login');
});

test('m9d705 smoke sem alvo ou sem credencial reprova sem inventar host', async () => {
  assert.match((await rodar({}, {})).erro.message, /DEV_API_BASE_URL/);
  assert.match((await rodar({ DEV_API_BASE_URL: base }, {})).erro.message, /DEV_SMOKE_EMAIL e DEV_SMOKE_PASSWORD, ou DEV_SMOKE_TOKEN/);
  assert.match((await rodar({ DEV_API_BASE_URL: base, DEV_SMOKE_EMAIL: 'x@y.z' }, {})).erro.message, /sem DEV_SMOKE_PASSWORD/);
  assert.equal(chamadas.length, 0);
});

test('m9d705 permissões do usuário de smoke: analytics:read e a permissão própria de cada painel do catálogo', () => {
  assert.deepEqual(permissoesDoSmoke().map((p) => p.permissao), ['analytics:read', 'analytics:read:tech', 'construction:read', 'correspondent:read', 'crm:feedback:read',
    'crm:opportunities:read', 'finance:read', 'inventory:read', 'legal:read', 'marketing:attribution:read']);
  assert.deepEqual(permissoesDoSmoke().find((p) => p.permissao === 'construction:read').paineis, ['construction', 'postwork']);
  assert.equal(permissoesDoSmoke().find((p) => p.permissao === 'analytics:read').paineis.length, DASHBOARD_CATALOG.length);
});

test('m9d705 o job de promoção recebe os segredos do usuário de smoke e diz que LAB é a homologação publicada', () => {
  for (const arquivo of ['analytics-esteira.yml', 'test.yml']) {
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', arquivo), 'utf8');
    const job = wf.slice(wf.indexOf('\n  bi-promocao:'), wf.indexOf('\n  ', wf.indexOf('steps:', wf.indexOf('\n  bi-promocao:'))));
    for (const segredo of ['DEV_API_BASE_URL', 'DEV_SMOKE_EMAIL', 'DEV_SMOKE_PASSWORD', 'DEV_SMOKE_TOKEN']) {
      assert.match(job, new RegExp(`${segredo}: \\$\\{\\{ secrets\\.${segredo} \\}\\}`), `${arquivo}: ${segredo}`);
    }
    assert.match(wf, /LAB = homologação publicada/, arquivo);
  }
});
