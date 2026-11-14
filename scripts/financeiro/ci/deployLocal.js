#!/usr/bin/env node
'use strict';

/**
 * Estágios 13 (deploy_DEV) e 14 (deploy_LAB) da esteira do Financeiro, na versão que roda no próprio job (o disparo do deploy real nos servidores DEV/LAB
 * é um passo à parte do workflow, por secret, só em branch de entrega). Sobe a API do HEAD como processo (`node app.js`), apontando para o banco
 * DESCARTÁVEL da esteira com a role de runtime (sem bypass de RLS), espera o /api/health e faz o smoke do Financeiro com o usuário fictício do CI:
 *   - DEV: /api/health 200, /api/version com o commit, rota financeira sem token 401, login (POST /auth/login) 200, lançamentos, contas,
 *          relatório semanal e fila de aprovações 200, leitura sem permissão (perfil de outra área) 403;
 *   - LAB: o mesmo build com DEPLOY_ENVIRONMENT=lab e o provedor bancário de laboratório (sandbox): além do smoke, o webhook bancário público não processa
 *          pagamento desconhecido nem corpo malformado e a suíte de contrato dos adapters bancários (scripts/contractReport.js bank-sandbox bank-santander) passa.
 * Nunca chama endpoint de MFA, nunca grava token. Sai com 1 se algo não respondeu como esperado.
 *
 *   node scripts/financeiro/ci/deployLocal.js --ambiente dev|lab
 */
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const i = process.argv.indexOf('--ambiente');
const AMBIENTE = i > 0 ? String(process.argv[i + 1]).toLowerCase() : '';

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function esperarSaude(base, limiteMs) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    try { const r = await fetch(`${base}/api/health`); if (r.status === 200) return r; } catch (_) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`/api/health não respondeu 200 em ${limiteMs / 1000} s`);
}

async function main() {
  if (!['dev', 'lab'].includes(AMBIENTE)) { console.error('Uso: node scripts/financeiro/ci/deployLocal.js --ambiente dev|lab'); return 2; }
  if (process.env.DISPOSABLE_DB !== '1') { console.error('RECUSADO: o deploy local só sobe contra o banco descartável da esteira.'); return 1; }
  const senha = process.env.CI_TENANT_USERS_PASSWORD;
  if (!senha) { console.error('CI_TENANT_USERS_PASSWORD ausente (seed de dois tenants do CI).'); return 1; }
  const { emailFor } = require('../../seed-ci-two-tenants');
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  const env = { ...process.env, PORT: String(porta), NODE_ENV: 'test', LOG_LEVEL: 'error', DEPLOY_ENVIRONMENT: AMBIENTE === 'lab' ? 'lab' : 'dev' };
  const api = spawn(process.execPath, ['app.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let erroApi = '';
  api.stderr.on('data', (d) => { erroApi += d.toString(); });
  const falhas = [];
  const conferir = (rotulo, ok, detalhe) => { console.log(`${ok ? 'OK   ' : 'FALHA'} ${AMBIENTE.toUpperCase()} ${rotulo}${detalhe ? ` (${detalhe})` : ''}`); if (!ok) falhas.push(rotulo); };
  try {
    const t0 = Date.now();
    await esperarSaude(base, 90000);
    conferir('GET /api/health -> 200', true, `API do HEAD no ar em ${((Date.now() - t0) / 1000).toFixed(1)} s, porta efêmera, banco descartável, role de runtime`);
    const versao = await fetch(`${base}/api/version`);
    conferir('GET /api/version -> 200', versao.status === 200, `HTTP ${versao.status}`);
    const anonimo = await fetch(`${base}/api/v1/finance/entries`);
    conferir('GET /api/v1/finance/entries sem token -> 401', anonimo.status === 401, `HTTP ${anonimo.status}`);
    const login = async (perfil) => {
      const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', perfil), password: senha }) });
      const corpo = await r.json().catch(() => ({}));
      conferir(`POST /api/v1/auth/login (perfil ${perfil} do tenant A) -> 200`, r.status === 200, `HTTP ${r.status}`);
      return corpo.data && corpo.data.accessToken;
    };
    const token = await login('gestor');
    const ler = async (rota, esperado, tk = token) => {
      const r = await fetch(`${base}/api/v1${rota}`, { headers: { Authorization: `Bearer ${tk}` } });
      conferir(`GET /api/v1${rota} -> ${esperado}`, r.status === esperado, `HTTP ${r.status}`);
    };
    for (const rota of ['/finance/entries', '/finance/bank-accounts', '/finance/reports/weekly-health', '/finance/approval-requests', '/finance/period-closures']) await ler(rota, 200);
    await ler('/audit-log', 403);
    if (AMBIENTE === 'lab') {
      const webhook = await fetch(`${base}/api/v1/finance/webhooks/bank-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalSubmissionId: 'lab-smoke-inexistente', status: 'CONFIRMED' }) });
      // Pagamento desconhecido: 200 para o banco não reenviar sem fim, mas NADA é processado e o motivo vem explícito (a recusa por HMAC ausente, com o
      // pagamento conhecido, é provada no estágio 8 pelo teste B5 "webhook bancário exige assinatura HMAC também em sandbox").
      const corpo = await webhook.json().catch(() => ({}));
      const d = corpo.data || {};
      conferir('POST /api/v1/finance/webhooks/bank-payment sem assinatura e com pagamento desconhecido -> nada processado', webhook.status === 200 && d.processed === false && d.reason === 'unknown_routing', `HTTP ${webhook.status}, processed=${d.processed}, reason=${d.reason}`);
      const malformado = await fetch(`${base}/api/v1/finance/webhooks/bank-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: ['CONFIRMED'] }) });
      conferir('POST /api/v1/finance/webhooks/bank-payment com corpo malformado -> 400', malformado.status === 400, `HTTP ${malformado.status}`);
      const contrato = spawnSync(process.execPath, ['scripts/contractReport.js', 'bank-sandbox', 'bank-santander'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: process.env.CI || 'true' } });
      process.stdout.write(contrato.stdout || '');
      conferir('suíte de contrato dos adapters bancários (bank-sandbox, bank-santander) em modo laboratório', contrato.status === 0, `exit ${contrato.status}`);
    }
  } catch (err) {
    falhas.push(err.message);
    console.error(`FALHA ${AMBIENTE.toUpperCase()}: ${err.message}\n${erroApi.split('\n').slice(-20).join('\n')}`);
  } finally {
    api.kill('SIGTERM');
  }
  console.log(`[deploy_${AMBIENTE === 'lab' ? 'LAB' : 'DEV'}] ${falhas.length ? `REPROVADO (${falhas.length} falha(s))` : 'OK'}`);
  return falhas.length ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`deploy local recusado: ${err.message}`); process.exit(1); });
