#!/usr/bin/env node
'use strict';
/**
 * Etapa DEV da esteira de Obras (Guia M6 §13), na versão que roda no próprio job (decisão DI-M6Q-1; o deploy no servidor DEV/LAB
 * do Patrick é por hook, só em tag obr-release-*). Sobe a API do HEAD como processo (`node app.js`) apontando para o banco
 * DESCARTÁVEL da esteira com a role de runtime (sem bypass de RLS), espera o /api/health e faz o smoke de Obras:
 *   /api/health 200; /api/version 200; rota de Obras sem token 401; login real (POST /auth/login) do perfil "gestor" do tenant A
 *   do CI 200 e, com esse token (que NÃO tem construction:*), GET /construction/projects 403 PERMISSION_DENIED;
 *   o mesmo usuário com construction:read (token assinado com a chave temporária do job, como os testes HTTP de Obras) lê a lista
 *   de obras e o painel (200) e não cria obra (403); outra empresa não lê nada.
 * Nunca chama endpoint de MFA, nunca grava token. Sai com 1 se algo não respondeu como esperado.
 *
 *   node scripts/ci-obras/deployLocal.js
 */
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const LIMITE_SUBIDA_MS = Number(process.env.OBR_CI_DEV_LIMITE_SUBIDA_MS) || 90000;

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function esperarSaude(base) {
  const fim = Date.now() + LIMITE_SUBIDA_MS;
  while (Date.now() < fim) {
    try { const r = await fetch(`${base}/api/health`); if (r.status === 200) return; } catch (_) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`/api/health não respondeu 200 em ${LIMITE_SUBIDA_MS / 1000} s`);
}

const decodificar = (token) => JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));

async function main() {
  if (process.env.DISPOSABLE_DB !== '1') { console.error('RECUSADO: o deploy local só sobe contra o banco descartável da esteira.'); return 1; }
  const senha = process.env.CI_TENANT_USERS_PASSWORD;
  if (!senha) { console.error('CI_TENANT_USERS_PASSWORD ausente (seed de dois tenants do CI).'); return 1; }
  const { emailFor } = require('../seed-ci-two-tenants');
  const { signAccessToken } = require('../../src/utils/jwt');
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  const api = spawn(process.execPath, ['app.js'], { cwd: ROOT, env: { ...process.env, PORT: String(porta), NODE_ENV: 'test', LOG_LEVEL: 'error', DEPLOY_ENVIRONMENT: 'dev' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let erroApi = '';
  api.stderr.on('data', (d) => { erroApi += d.toString(); });
  const falhas = [];
  const conferir = (rotulo, ok, detalhe) => { console.log(`${ok ? 'OK   ' : 'FALHA'} DEV ${rotulo}${detalhe ? ` (${detalhe})` : ''}`); if (!ok) falhas.push(rotulo); };
  const chamar = (metodo, rota, token, corpo) => fetch(`${base}/api/v1${rota}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  try {
    const t0 = Date.now();
    await esperarSaude(base);
    conferir('GET /api/health -> 200', true, `API do HEAD no ar em ${((Date.now() - t0) / 1000).toFixed(1)} s, porta efêmera, banco descartável, role de runtime`);
    const versao = await fetch(`${base}/api/version`);
    conferir('GET /api/version -> 200', versao.status === 200, `HTTP ${versao.status}`);
    const anonimo = await chamar('GET', '/construction/projects');
    conferir('GET /api/v1/construction/projects sem token -> 401', anonimo.status === 401, `HTTP ${anonimo.status}`);
    const login = await chamar('POST', '/auth/login', null, { email: emailFor('A', 'gestor'), password: senha });
    const corpoLogin = await login.json().catch(() => ({}));
    const tokenGestor = corpoLogin.data && corpoLogin.data.accessToken;
    conferir('POST /api/v1/auth/login (perfil gestor do tenant A, sem construction:*) -> 200', login.status === 200 && Boolean(tokenGestor), `HTTP ${login.status}`);
    const semPerm = await chamar('GET', '/construction/projects', tokenGestor);
    const codigo = ((await semPerm.json().catch(() => ({}))).error || {}).code;
    conferir('GET /api/v1/construction/projects com o login real sem construction:read -> 403 PERMISSION_DENIED', semPerm.status === 403 && codigo === 'PERMISSION_DENIED', `HTTP ${semPerm.status} ${codigo || ''}`);
    const quem = decodificar(tokenGestor);
    const leitor = signAccessToken({ sub: quem.sub, group_id: quem.group_id, company_id: quem.company_id, roles: ['ci-obras'], permissions: ['construction:read'] });
    for (const rota of ['/construction/projects', '/construction/dashboard']) {
      const r = await chamar('GET', rota, leitor);
      conferir(`GET /api/v1${rota} com construction:read -> 200`, r.status === 200, `HTTP ${r.status}`);
    }
    const criar = await chamar('POST', '/construction/projects', leitor, { name: 'DEV smoke — não deve nascer' });
    conferir('POST /api/v1/construction/projects só com construction:read -> 403', criar.status === 403, `HTTP ${criar.status}`);
    const outra = signAccessToken({ sub: quem.sub, group_id: quem.group_id, company_id: crypto.randomUUID(), roles: ['ci-obras'], permissions: ['construction:read'] });
    const lista = await (await chamar('GET', '/construction/projects', outra)).json().catch(() => ({}));
    const itens = Array.isArray(lista.data) ? lista.data : (lista.data && lista.data.items) || [];
    conferir('GET /api/v1/construction/projects de uma empresa sem obras -> lista vazia (RLS)', itens.length === 0, `${itens.length} obra(s)`);
  } catch (err) {
    falhas.push(err.message);
    console.error(`FALHA DEV: ${err.message}\n${erroApi.split('\n').slice(-20).join('\n')}`);
  } finally {
    api.kill('SIGTERM');
  }
  console.log(`[DEV] ${falhas.length ? `REPROVADO (${falhas.length} falha(s))` : 'OK'}`);
  return falhas.length ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`deploy local recusado: ${err.message}`); process.exit(1); });
