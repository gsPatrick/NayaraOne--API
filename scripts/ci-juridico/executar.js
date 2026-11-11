#!/usr/bin/env node
'use strict';
/**
 * Esteira de CI/CD do jurídico (Guia do Marco 5, §17): roda as 18 etapas na ordem do livro e PARA na
 * primeira vermelha (as seguintes ficam NAO_RODOU). Sem --release, as etapas de release (deploy_DEV,
 * deploy_LAB, production_approval) saem NAO_APLICAVEL. production_approval nunca faz deploy: marca
 * AGUARDANDO_APROVACAO. Grava o relatório (nome, status, duração, commit) em --relatorio.
 *
 *   node scripts/ci-juridico/executar.js [--release] [--relatorio arquivo.json] [--de N] [--ate N]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ETAPAS, validar } = require('./etapas');

const ROOT = path.resolve(__dirname, '..', '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const RELEASE = process.argv.includes('--release');
const RELATORIO = arg('--relatorio') || path.join(ROOT, 'docs', 'evidencias', 'ci', 'esteira-juridico.json');
const DE = Number(arg('--de') || 1);
const ATE = Number(arg('--ate') || ETAPAS.length);

function commit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'fora de git';
}

function rodar(e) {
  if (e.release && !RELEASE) return { status: 'NAO_APLICAVEL', motivo: 'etapa de release: só em tag jur-release-*' };
  if (e.aprovacao) return { status: 'AGUARDANDO_APROVACAO', motivo: 'o CI não faz deploy em produção; o environment pede a aprovação do responsável' };
  if (e.banco && process.env.DISPOSABLE_DB !== '1') return { status: 'VERMELHO', motivo: 'etapa de banco só roda em banco descartável (scripts/withDisposableDb.js)' };
  const portaDrill = String(Number(process.env.JUR_CI_PORTA_DRILL || 40000 + Math.floor(Math.random() * 1500)));
  for (const c of e.comandos) {
    const argv = c.map((t) => t.replace('{portaDrill}', portaDrill));
    process.stdout.write(`$ ${argv.join(' ')}\n`);
    const r = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' } });
    if (r.status !== 0) return { status: 'VERMELHO', motivo: `comando terminou com ${r.status}: ${argv.join(' ')}` };
  }
  return { status: 'VERDE', motivo: `${e.comandos.length} comando(s)` };
}

function main() {
  validar();
  const sha = commit();
  const relatorio = { esteira: 'juridico (Guia M5 §17)', commit: sha, release: RELEASE, inicio: new Date().toISOString(), etapas: [] };
  let parou = false;
  ETAPAS.forEach((e, i) => {
    const numero = i + 1;
    if (numero < DE || numero > ATE) return;
    if (parou) { relatorio.etapas.push({ numero, nome: e.nome, status: 'NAO_RODOU', motivo: 'etapa anterior vermelha', commit: sha }); return; }
    const t0 = Date.now();
    process.stdout.write(`\n=== Etapa ${numero}: ${e.nome} ===\n`);
    const r = rodar(e);
    relatorio.etapas.push({ numero, nome: e.nome, ...r, duracaoMs: Date.now() - t0, commit: sha });
    process.stdout.write(`=== Etapa ${numero}: ${e.nome} -> ${r.status} (${r.motivo}) ===\n`);
    if (r.status === 'VERMELHO') { parou = true; process.stdout.write('LEGAL_CI_STAGE_FAILED\n'); }
  });
  relatorio.fim = new Date().toISOString();
  fs.mkdirSync(path.dirname(RELATORIO), { recursive: true });
  fs.writeFileSync(RELATORIO, `${JSON.stringify(relatorio, null, 1)}\n`);
  process.exit(parou ? 1 : 0);
}

main();
