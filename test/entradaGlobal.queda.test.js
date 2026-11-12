'use strict';

// Verificação independente do Marco 9, rodada 7 (12/11/2026), item 1: com a API no processo de verdade (`node app.js`, sem o executor de testes), o
// `PUT /settings/<chave numérica>` com `value` aninhado em 50 mil níveis derrubava o processo (o errorHandler assíncrono rejeitava ao serializar o
// valor devolvido em `details`; a promessa sem tratamento encerrava a API para todas as empresas). Aqui o processo sobe, recebe os pedidos que o
// derrubavam e tem de continuar respondendo (DI-M9R-18 e DI-M9R-19). Só em banco descartável (precisa de usuário com `settings:update`).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ENTRADA_GLOBAL_QUEDA_PORT || require('./marco9/_helpers/portaLivre').portaLivre());
const BASE = `http://127.0.0.1:${PORT}`;
const DISPOSABLE = process.env.DISPOSABLE_DB === '1';
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-queda-${SUFIXO}@ci.nayaraone.test`;

let filho = null;
let saida = '';
let saiu = null;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function saude() {
  try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).status; } catch (e) { return `sem resposta (${e.cause ? e.cause.code : e.name})`; }
}

before(async () => {
  if (!DISPOSABLE) return;
  // Só o banco (sem subir a API neste processo): o apoio de tenants da integração não requer o app.js.
  const env = require('./integrations/dispatch/dispatchHelpers');
  const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');
  const A = (await env.carregarTenants()).tenant;
  const ps = await Permission.findAll({ where: { code: ['settings:update', 'settings:read'] } });
  const user = await User.create({ name: 'CI queda', email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI QUEDA ${SUFIXO}`, description: 'Perfil fictício do teste de queda.', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId: user.id, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  await env.sequelize.close();
  process.env.CI_QUEDA_COMPANY = A.companyId;
  // o processo de verdade, como em produção: `node app.js` (NODE_ENV=test só desliga os jobs agendados e a migration no boot)
  filho = spawn(process.execPath, ['app.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  filho.stdout.on('data', (d) => { saida += d; if (saida.length > 2e6) saida = saida.slice(-1e6); });
  filho.stderr.on('data', (d) => { saida += d; });
  filho.on('exit', (code, sinal) => { saiu = { code, sinal }; });
  for (let i = 0; i < 100 && (await saude()) !== 200 && !saiu; i += 1) await espera(300);
});

after(() => { if (filho && !saiu) filho.kill('SIGKILL'); });

test('node app.js: PUT /settings com value de 50 mil níveis não derruba a API e ela continua respondendo', { skip: DISPOSABLE ? false : 'precisa do banco descartável (node scripts/withDisposableDb.js)' }, async () => {
  assert.equal(await saude(), 200, `a API subiu (saída: ${saida.slice(-400)})`);
  const login = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: process.env.CI_QUEDA_COMPANY }) });
  assert.equal(login.status, 200);
  const tk = (await login.json()).data.accessToken;
  for (const [chave, niveis] of [['integration.messaging.inbound_lead_prazo_horas', 5000], ['integration.messaging.inbound_lead_prazo_horas', 50000], ['integration.whatsapp.max_text_chars', 50000], ['integration.whatsapp.max_text_chars', 500000]]) {
    const corpo = `{"value":${'{"a":'.repeat(niveis)}1${'}'.repeat(niveis)}}`;
    let r;
    try {
      const x = await fetch(`${BASE}/api/v1/settings/${chave}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: corpo, signal: AbortSignal.timeout(15000) });
      r = { status: x.status, body: await x.json() };
    } catch (e) {
      r = { status: `sem resposta (${e.cause ? e.cause.code : e.name})` };
    }
    assert.equal(r.status, 400, `${chave} ${niveis} níveis -> ${r.status}`);
    assert.equal(r.body.error.code, 'REQUEST_BODY_TOO_DEEP');
    await espera(500);
    assert.equal(saiu, null, `o processo da API terminou: ${JSON.stringify(saiu)} (saída: ${saida.slice(-600)})`);
    assert.equal(await saude(), 200, `a API responde depois de ${niveis} níveis`);
  }
  const lista = await fetch(`${BASE}/api/v1/settings`, { headers: { Authorization: `Bearer ${tk}` } });
  assert.equal(lista.status, 200, 'e atende pedidos autenticados normalmente');
  assert.doesNotMatch(saida, /Maximum call stack size exceeded|PROCESS_UNHANDLED_REJECTION|PROCESS_UNCAUGHT_EXCEPTION/, 'sem estouro de pilha nem rejeição sem tratamento no registro');
});
