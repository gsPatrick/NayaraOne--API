#!/usr/bin/env node
'use strict';
/**
 * Etapas deploy_DEV e deploy_LAB da esteira do jurídico (Guia M5 §17), na parte que roda no próprio job, em todo push e
 * pull request (decisão DI-M5ES-1; o servidor DEV/LAB do Patrick é o hook de scripts/ci-juridico/deploy.js, só em tag):
 *   1. monta o ARTEFATO do commit (git archive + VERSION, como o Dockerfile; scripts/ci-juridico/artefato.js);
 *   2. DEV: publica sobre o banco descartável da esteira (o mesmo das etapas 3 a 12);
 *      LAB: cria um banco NOVO (drill_lab) no cluster descartável e o prepara pelo comando de deploy do runbook
 *      (`node scripts/migrate.js up`, de dentro do artefato), seeds base, GRANT da role de runtime e o seed de dois
 *      tenants do CI;
 *   3. sobe a API do artefato (`node app.js`) com a role de runtime (sem superusuário nem BYPASSRLS) e espera /api/health;
 *   4. smoke do jurídico (scripts/ci-juridico/smokeJuridico.js) e grava <evidencias>/deploy-<AMB>.json.
 * Sai 1 se qualquer verificação falhar. Nunca toca banco que não seja o descartável (DISPOSABLE_DB=1, 127.0.0.1).
 *
 *   node scripts/ci-juridico/deployLocal.js DEV|LAB --evidencias <pasta>
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { montarArtefato } = require('./artefato');
const { smokeJuridico } = require('./smokeJuridico');

const ROOT = path.resolve(__dirname, '..', '..');
const LIMITE_SUBIDA_MS = Number(process.env.JUR_CI_LIMITE_SUBIDA_MS) || 180000;

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function trocarBanco(url, banco) {
  const u = new URL(url);
  u.pathname = `/${banco}`;
  return u.toString();
}

function rodarNoArtefato(dir, titulo, args, env) {
  const r = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${titulo} falhou (exit ${r.status}): ${`${r.stdout}${r.stderr}`.split('\n').slice(-25).join('\n')}`);
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/** LAB: banco novo preparado pelo comando de deploy, de dentro do artefato. Devolve { appUrl, adminUrl, migrations }. */
function prepararBancoLab(dir) {
  const cluster = require('../lib/disposableCluster');
  const admin = new URL(process.env.DATABASE_ADMIN_URL);
  if (!['127.0.0.1', 'localhost'].includes(admin.hostname)) throw new Error('RECUSADO: o banco do LAB local só é criado no cluster descartável local.');
  const porta = Number(admin.port);
  cluster.psql(porta, 'postgres', 'DROP DATABASE IF EXISTS drill_lab');
  cluster.psql(porta, 'postgres', 'CREATE DATABASE drill_lab');
  const adminUrl = trocarBanco(process.env.DATABASE_ADMIN_URL, 'drill_lab');
  const appUrl = trocarBanco(process.env.DATABASE_URL, 'drill_lab');
  const envAdmin = { ...process.env, DATABASE_URL: adminUrl, NODE_ENV: 'development', DB_SSL: 'false' };
  const saida = rodarNoArtefato(dir, 'node scripts/migrate.js up', ['scripts/migrate.js', 'up'], envAdmin);
  const migrations = (saida.match(/migrated/g) || []).length;
  if (migrations === 0) throw new Error('o comando de deploy não aplicou nenhuma migration no banco novo do LAB');
  for (const seed of ['scripts/seed-dev.js', 'scripts/seedBillingRules.js', 'scripts/seedRealEstateRules.js']) rodarNoArtefato(dir, seed, [seed], envAdmin);
  cluster.grantRuntime(porta, 'drill_lab');
  rodarNoArtefato(dir, 'seed-ci-two-tenants', ['scripts/seed-ci-two-tenants.js'], { ...process.env, DATABASE_URL: appUrl, NODE_ENV: 'test' });
  return { appUrl, adminUrl, migrations };
}

async function esperarSaude(base, api) {
  const fim = Date.now() + LIMITE_SUBIDA_MS;
  while (Date.now() < fim) {
    if (api.exitCode !== null) throw new Error(`a API do artefato terminou ao subir (exit ${api.exitCode})`);
    try { const r = await fetch(`${base}/api/health`); if (r.status === 200) return; } catch (_) { /* ainda subindo */ }
    await new Promise((r) => { setTimeout(r, 500); });
  }
  throw new Error(`/api/health não respondeu 200 em ${LIMITE_SUBIDA_MS / 1000} s`);
}

async function main(argv = process.argv.slice(2)) {
  const amb = String(argv[0] || '').toUpperCase();
  const i = argv.indexOf('--evidencias');
  const evidencias = i >= 0 ? argv[i + 1] : null;
  if (!['DEV', 'LAB'].includes(amb) || !evidencias) { console.error('uso: deployLocal.js DEV|LAB --evidencias <pasta>'); return 2; }
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) { console.error('RECUSADO: o deploy local só publica sobre o banco descartável da esteira.'); return 2; }
  const senha = process.env.CI_TENANT_USERS_PASSWORD;
  if (!senha) { console.error('CI_TENANT_USERS_PASSWORD ausente (seed de dois tenants do CI).'); return 2; }
  const { emailFor } = require('../seed-ci-two-tenants');
  const relatorio = { etapa: `deploy_${amb}`, modo: 'local (artefato do commit; servidor do Patrick só em tag jur-release-*)', inicio: new Date().toISOString(), verificacoes: [] };
  let artefato = null;
  let api = null;
  let erroApi = '';
  try {
    artefato = montarArtefato(ROOT, amb);
    relatorio.commit = artefato.commit;
    relatorio.artefato = 'git archive do commit + VERSION (como o Dockerfile) + node_modules do job';
    let banco = { appUrl: process.env.DATABASE_URL, adminUrl: process.env.DATABASE_ADMIN_URL };
    if (amb === 'LAB') {
      banco = prepararBancoLab(artefato.dir);
      relatorio.banco = `drill_lab (banco novo no cluster descartável; ${banco.migrations} migrations pelo comando de deploy "node scripts/migrate.js up" de dentro do artefato; seeds base; GRANT da role de runtime; seed de dois tenants do CI)`;
    } else {
      relatorio.banco = 'drill_app (banco descartável da esteira, já migrado e usado pelas etapas 3 a 12)';
    }
    const porta = Number(process.env[`JUR_CI_PORTA_HTTP_${amb}`]) || await portaLivre();
    const uploads = fs.mkdtempSync(path.join(os.tmpdir(), `jur-ci-uploads-${amb.toLowerCase()}-`));
    const runtimeRole = new URL(banco.appUrl).username;
    api = spawn(process.execPath, ['app.js'], {
      cwd: artefato.dir,
      env: { ...process.env, PORT: String(porta), DATABASE_URL: banco.appUrl, NODE_ENV: 'test', LOG_LEVEL: 'error', DEPLOY_ENVIRONMENT: amb.toLowerCase(), UPLOADS_DIR: uploads },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    api.stderr.on('data', (d) => { erroApi = `${erroApi}${d}`.slice(-8000); });
    const base = `http://127.0.0.1:${porta}`;
    const t0 = Date.now();
    await esperarSaude(base, api);
    relatorio.subidaMs = Date.now() - t0;
    relatorio.verificacoes = await smokeJuridico({ base, commitEsperado: artefato.commit, senha, emailFor, adminUrl: banco.adminUrl, runtimeRole });
  } catch (err) {
    relatorio.verificacoes.push({ item: 'deploy local', ok: false, detalhe: err.message.slice(0, 1500) });
    console.error(`FALHA deploy_${amb}: ${err.message}\n${erroApi.split('\n').slice(-20).join('\n')}`);
  } finally {
    if (api && api.exitCode === null) api.kill('SIGTERM');
    if (artefato) artefato.remover();
  }
  const falhas = relatorio.verificacoes.filter((v) => !v.ok);
  relatorio.resultado = falhas.length === 0 && relatorio.verificacoes.length > 0 ? 'VERDE' : 'VERMELHO';
  relatorio.fim = new Date().toISOString();
  fs.mkdirSync(evidencias, { recursive: true });
  fs.writeFileSync(path.join(evidencias, `deploy-${amb}.json`), `${JSON.stringify(relatorio, null, 1)}\n`);
  console.log(`[deploy_${amb}] ${relatorio.resultado} (${relatorio.verificacoes.length - falhas.length}/${relatorio.verificacoes.length} verificações)`);
  return relatorio.resultado === 'VERDE' ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (err) => { console.error(`deploy local recusado: ${err.message}`); process.exit(1); });

module.exports = { main, trocarBanco };
