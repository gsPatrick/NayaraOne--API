#!/usr/bin/env node
'use strict';
/**
 * Esteira de CI/CD do jurídico (Guia do Marco 5, §17): roda as 18 etapas na ordem do livro e PARA na primeira vermelha
 * (as seguintes ficam NAO_RODOU). Todas as etapas rodam em todo push e pull request (DI-M5ES-1); com --release (tag
 * jur-release-*) deploy_DEV e deploy_LAB também disparam o hook do servidor do Patrick. A etapa 18 é o portão de produção
 * (nunca faz deploy). O relatório (nome, status, duração, commit, árvore limpa ou não) é regravado ao fim de cada etapa,
 * porque o portão lê o relatório da própria execução. As evidências de cada etapa (resultados de teste por etapa, relatório
 * do drill de restore, do pentest, do deploy local e do portão) ficam em --evidencias (padrão: <relatorio>-evidencias/). O padrão
 * do relatório é fora do repositório (tmpdir): arquivo novo na árvore contaria como alteração no pentest e no portão.
 *
 *   node scripts/ci-juridico/executar.js [--release] [--relatorio arquivo.json] [--evidencias pasta] [--de N] [--ate N]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ETAPAS, validar } = require('./etapas');
const { executarEsteira } = require('../lib/esteiraLivro');

const ROOT = path.resolve(__dirname, '..', '..');

function argumento(argv, nome) {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : null;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function estadoDoCodigo() {
  const sha = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']) || 'fora de git';
  const sujo = git(['status', '--porcelain', '--untracked-files=no']);
  return { commit: sha, dirty: sujo === null ? null : sujo.length > 0 };
}

function trocar(texto, valores) {
  return String(texto).replace(/\{([a-zA-Z]+)\}/g, (inteiro, nome) => (nome in valores ? valores[nome] : inteiro));
}

function rodarEtapa(e, valores, release) {
  if (e.banco && process.env.DISPOSABLE_DB !== '1') return { status: 'VERMELHO', motivo: 'etapa de banco só roda em banco descartável (scripts/withDisposableDb.js)' };
  const comandos = [...e.comandos, ...(release && e.comandosRelease ? e.comandosRelease : [])];
  const envEtapa = Object.fromEntries(Object.entries(e.env || {}).map(([k, v]) => [k, trocar(v, valores)]));
  for (const c of comandos) {
    const argv = c.map((t) => trocar(t, valores));
    process.stdout.write(`$ ${argv.join(' ')}\n`);
    const r = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test', ...envEtapa } });
    if (r.status !== 0) return { status: 'VERMELHO', motivo: `comando terminou com ${r.status}: ${argv.join(' ')}` };
  }
  if (e.aprovacao) {
    return { status: 'VERDE', motivo: release
      ? 'portão de produção liberado; a aprovação humana segue no job aprovacao-producao (environment juridico-aprovacao); o CI não publica em produção'
      : 'portão de produção liberado; fora de tag jur-release-* não há publicação nem aprovação a pedir; o CI não publica em produção' };
  }
  const modo = e.deploy ? (release ? ' (deploy local do artefato + hook do servidor)' : ' (deploy local do artefato; o hook do servidor só em tag jur-release-*)') : '';
  return { status: 'VERDE', motivo: `${comandos.length} comando(s)${modo}` };
}

function gravar(arquivo, relatorio) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, `${JSON.stringify(relatorio, null, 1)}\n`);
}

function executar(argv = process.argv.slice(2)) {
  validar();
  const release = argv.includes('--release');
  const relatorioArq = path.resolve(argumento(argv, '--relatorio') || path.join(os.tmpdir(), 'esteira-juridico', 'esteira-juridico.json'));
  const evidencias = path.resolve(argumento(argv, '--evidencias') || relatorioArq.replace(/\.json$/, '') + '-evidencias');
  const de = Number(argumento(argv, '--de') || 1);
  const ate = Number(argumento(argv, '--ate') || ETAPAS.length);
  fs.mkdirSync(path.join(evidencias, 'testes'), { recursive: true });
  const portaDrill = String(Number(process.env.JUR_CI_PORTA_DRILL) || 40000 + Math.floor(Math.random() * 1500));
  const { commit, dirty } = estadoDoCodigo();
  const relatorio = { esteira: 'juridico (Guia M5 §17)', commit, dirty, release, de, ate, evidencias, inicio: new Date().toISOString(), etapas: [] };
  let parou = false;
  ETAPAS.forEach((e, i) => {
    const numero = i + 1;
    if (numero < de || numero > ate) return;
    if (parou) { relatorio.etapas.push({ numero, nome: e.nome, status: 'NAO_RODOU', motivo: 'etapa anterior vermelha', commit }); return; }
    const t0 = Date.now();
    process.stdout.write(`\n=== Etapa ${numero}: ${e.nome} ===\n`);
    const r = rodarEtapa(e, { evidencias, relatorio: relatorioArq, etapa: `${String(numero).padStart(2, '0')}-${e.nome}`, portaDrill }, release);
    relatorio.etapas.push({ numero, nome: e.nome, ...r, duracaoMs: Date.now() - t0, commit });
    process.stdout.write(`=== Etapa ${numero}: ${e.nome} -> ${r.status} (${r.motivo}) ===\n`);
    if (r.status === 'VERMELHO') { parou = true; process.stdout.write('LEGAL_CI_STAGE_FAILED\n'); }
    gravar(relatorioArq, relatorio);
  });
  relatorio.fim = new Date().toISOString();
  relatorio.resultado = parou ? 'VERMELHO' : 'VERDE';
  gravar(relatorioArq, relatorio);
  return parou ? 1 : 0;
}

if (require.main === module) process.exit(executar());

module.exports = { executar, rodarEtapa, trocar, estadoDoCodigo };
