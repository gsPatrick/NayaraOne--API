#!/usr/bin/env node
'use strict';
/**
 * Esteira de CI/CD do Marco 3 (Guia do Marcelo do Marco 3, §16): roda as 17 etapas na ordem do livro e PARA na primeira vermelha (as
 * seguintes ficam NAO_RODOU). Antes de qualquer comando, confere a definição (scripts/ci-marco3/etapas.js), que todo arquivo de teste
 * citado existe e que os testes exigidos continuam nos arquivos: qualquer falha RECUSA a esteira inteira. Sem --release, deploy_DEV,
 * deploy_LAB e production_approval saem NAO_APLICAVEL (ditas no relatório, nunca contadas como verdes). production_approval nunca faz
 * deploy. Grava o relatório JSON por etapa (status, motivo, duração, commit, arquivos de teste, contagem de testes) em --relatorio.
 *
 *   node scripts/ci-marco3/executar.js [--release] [--relatorio arquivo.json] [--de N] [--ate N] [--config etapas.json]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const E = require('./etapas');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const RELEASE = process.argv.includes('--release');
const RELATORIO = path.resolve(E.ROOT, arg('--relatorio') || 'docs/evidencias/ci/esteira-marco3.json');
const CONFIG = arg('--config') ? path.resolve(arg('--config')) : E.CONFIG;
const DE = Number(arg('--de') || 1);
const ATE = Number(arg('--ate') || E.NOMES_DO_LIVRO.length);
const PASTA_TAP = path.join(E.ROOT, 'reports', 'm3-ci'); // TAP de cada comando de teste (não versionado; o workflow arquiva)

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: E.ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'fora de git';
}

/** Lê "# pass N" / "# fail N" / "# skipped N" do TAP gravado pelo node --test. */
function contagem(tap) {
  const texto = fs.existsSync(tap) ? fs.readFileSync(tap, 'utf8') : '';
  const n = (k) => { const m = texto.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : null; };
  return { testes: n('tests'), passaram: n('pass'), falharam: n('fail'), pulados: n('skipped') };
}

function rodarComando(argv, etapa, i) {
  let final = argv;
  let tap = null;
  if (argv[0] === 'node' && argv[1] === '--test') {
    fs.mkdirSync(PASTA_TAP, { recursive: true });
    tap = path.join(PASTA_TAP, `etapa-${etapa.numero}-${i}.tap`);
    final = ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tap}`, ...argv.slice(2)];
  }
  process.stdout.write(`$ ${final.join(' ')}\n`);
  const r = spawnSync(final[0], final.slice(1), { cwd: E.ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' } });
  return { argv: tap ? argv.slice(0, 3).concat(`(${argv.length - 3} arquivos)`) : argv, status: r.status, ...(tap ? contagem(tap) : {}) };
}

function rodar(etapa) {
  const base = { numero: etapa.numero, nome: etapa.nome, tipo: etapa.tipo };
  if (etapa.tipo === 'release' && !RELEASE) return { ...base, status: 'NAO_APLICAVEL', motivo: `etapa de release: só em tag ${E.TAG_RELEASE}* (job release-marco3)` };
  if (etapa.tipo === 'aprovacao' && !RELEASE) return { ...base, status: 'NAO_APLICAVEL', motivo: `só em tag ${E.TAG_RELEASE}*, no job aprovacao-marco3 atrás do environment marco3-aprovacao (revisor obrigatório)` };
  if (etapa.banco && process.env.DISPOSABLE_DB !== '1') return { ...base, status: 'VERMELHO', motivo: 'etapa de banco só roda em banco descartável (scripts/withDisposableDb.js)' };
  const arquivos = E.arquivosDeTeste(etapa);
  const comandos = [];
  for (const [i, argv] of E.comandosDaEtapa(etapa).entries()) {
    const r = rodarComando(argv, etapa, i);
    comandos.push(r);
    if (r.status !== 0) return { ...base, status: 'VERMELHO', motivo: `comando terminou com ${r.status}: ${r.argv.join(' ')}`, arquivosDeTeste: arquivos, comandos };
  }
  if (etapa.tipo === 'aprovacao') {
    const noCi = process.env.GITHUB_ACTIONS === 'true';
    return {
      ...base, comandos,
      status: noCi ? 'VERDE' : 'AGUARDANDO_APROVACAO',
      motivo: noCi
        ? `o environment marco3-aprovacao liberou o job (revisor aprovou); execução ${process.env.GITHUB_RUN_ID}; nenhum deploy feito pelo CI`
        : 'portão conferido fora do GitHub: a aprovação é do revisor do environment marco3-aprovacao; nenhum deploy feito',
    };
  }
  return { ...base, status: 'VERDE', motivo: `${comandos.length} comando(s)`, arquivosDeTeste: arquivos, comandos };
}

function recusar(relatorio, err) {
  relatorio.recusada = err.message;
  process.stdout.write(`${err.message}\n`);
}

function main() {
  const sha = commit();
  const relatorio = { esteira: 'Marco 3 — Pessoas, Imóveis, CRM e Radar (Guia M3 §16)', commit: sha, release: RELEASE, de: DE, ate: ATE, inicio: new Date().toISOString(), etapas: [] };
  let falhou = false;
  try {
    const { etapas } = E.carregar(CONFIG);
    for (const e of etapas) {
      E.comandosDaEtapa(e);
      const faltam = E.testesExigidosAusentes(e);
      if (faltam.length) throw new E.EsteiraInvalida(`etapa ${e.numero} (${e.nome}): testes exigidos ausentes: ${faltam.join(' | ')}`);
    }
    for (const e of etapas) {
      if (e.numero < DE || e.numero > ATE) continue;
      if (falhou) { relatorio.etapas.push({ numero: e.numero, nome: e.nome, tipo: e.tipo, status: 'NAO_RODOU', motivo: 'etapa anterior vermelha', commit: sha }); continue; }
      const t0 = Date.now();
      process.stdout.write(`\n=== Etapa ${e.numero}: ${e.nome} ===\n`);
      const r = rodar(e);
      relatorio.etapas.push({ ...r, duracaoMs: Date.now() - t0, commit: sha });
      process.stdout.write(`=== Etapa ${e.numero}: ${e.nome} -> ${r.status} (${r.motivo}) ===\n`);
      if (r.status === 'VERMELHO') { falhou = true; process.stdout.write(`${E.CODIGO_FALHA}\n`); }
    }
  } catch (err) {
    if (!(err instanceof E.EsteiraInvalida)) throw err;
    recusar(relatorio, err);
    falhou = true;
  }
  relatorio.fim = new Date().toISOString();
  fs.mkdirSync(path.dirname(RELATORIO), { recursive: true });
  fs.writeFileSync(RELATORIO, `${JSON.stringify(relatorio, null, 1)}\n`);
  process.exit(falhou ? 1 : 0);
}

main();
