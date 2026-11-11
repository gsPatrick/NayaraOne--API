'use strict';
/**
 * Executor comum das esteiras de CI/CD "na ordem do livro" (jurídico, Guia M5 §17; Obras, Guia M6 §13). Cada esteira traz só a
 * sua lista de etapas (nome literal do livro + comandos) e a validação dos nomes; este módulo roda as etapas na ordem e PARA na
 * primeira vermelha (as seguintes ficam NAO_RODOU). Etapa `release: true` sai NAO_APLICAVEL sem --release (dito no relatório,
 * nunca contada como verde); `aprovacao: true` só registra AGUARDANDO_APROVACAO (o CI nunca faz deploy em produção);
 * `banco: true` recusa rodar fora do banco descartável (scripts/withDisposableDb.js). Grava o relatório por etapa.
 *
 * Marcadores nos comandos: `{nome}` é trocado pelo valor de `portas[nome]` (variável de ambiente indicada; sem ela, porta
 * aleatória na faixa da esteira). `NODE_TEST(...)` monta `node --test --test-concurrency=1 ...`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE_TEST = (...arquivos) => ['node', '--test', '--test-concurrency=1', ...arquivos];

function argumento(argv, nome) {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : null;
}

function commitAtual(raiz) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: raiz, encoding: 'utf8' });
  return process.env.GITHUB_SHA || (r.status === 0 ? r.stdout.trim() : 'fora de git');
}

/** Valores dos marcadores: a variável de ambiente indicada ou uma porta aleatória (base + 0..faixa-1), fixada para a execução toda. */
function resolverPortas(portas = {}, env = process.env) {
  const valores = {};
  for (const [nome, def] of Object.entries(portas)) {
    valores[nome] = String(Number(env[def.env]) || def.base + Math.floor(Math.random() * def.faixa));
  }
  return valores;
}

function trocarMarcadores(argv, valores) {
  return argv.map((t) => t.replace(/\{([a-zA-Z]+)\}/g, (inteiro, nome) => (nome in valores ? valores[nome] : inteiro)));
}

function rodarEtapa(e, cfg, valores, release) {
  if (e.release && !release) return { status: 'NAO_APLICAVEL', motivo: cfg.motivoRelease };
  if (e.aprovacao) return { status: 'AGUARDANDO_APROVACAO', motivo: 'o CI não faz deploy em produção; o environment pede a aprovação do responsável' };
  if (e.banco && process.env.DISPOSABLE_DB !== '1') return { status: 'VERMELHO', motivo: 'etapa de banco só roda em banco descartável (scripts/withDisposableDb.js)' };
  const envEtapa = Object.fromEntries(Object.entries(e.env || {}).map(([k, v]) => [k, trocarMarcadores([v], valores)[0]]));
  for (const c of e.comandos) {
    const argv = trocarMarcadores(c, valores);
    process.stdout.write(`$ ${argv.join(' ')}\n`);
    const r = spawnSync(argv[0], argv.slice(1), { cwd: cfg.raiz, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test', ...envEtapa } });
    if (r.status !== 0) return { status: 'VERMELHO', motivo: `comando terminou com ${r.status}: ${argv.join(' ')}` };
  }
  return { status: 'VERDE', motivo: `${e.comandos.length} comando(s)` };
}

/**
 * cfg: { esteira, etapas, validar, raiz, relatorioPadrao, codigoFalha, motivoRelease, portas }
 * argv: [--release] [--relatorio arquivo.json] [--de N] [--ate N]. Devolve o código de saída (0 só se nada ficou vermelho).
 */
function executarEsteira(cfg, argv = process.argv.slice(2)) {
  cfg.validar();
  const release = argv.includes('--release');
  const relatorioArq = argumento(argv, '--relatorio') || cfg.relatorioPadrao;
  const de = Number(argumento(argv, '--de') || 1);
  const ate = Number(argumento(argv, '--ate') || cfg.etapas.length);
  const valores = resolverPortas(cfg.portas);
  const sha = commitAtual(cfg.raiz);
  const relatorio = { esteira: cfg.esteira, commit: sha, release, inicio: new Date().toISOString(), etapas: [] };
  let parou = false;
  cfg.etapas.forEach((e, i) => {
    const numero = i + 1;
    if (numero < de || numero > ate) return;
    if (parou) { relatorio.etapas.push({ numero, nome: e.nome, status: 'NAO_RODOU', motivo: 'etapa anterior vermelha', commit: sha }); return; }
    const t0 = Date.now();
    process.stdout.write(`\n=== Etapa ${numero}: ${e.nome} ===\n`);
    const r = rodarEtapa(e, cfg, valores, release);
    relatorio.etapas.push({ numero, nome: e.nome, ...r, duracaoMs: Date.now() - t0, commit: sha });
    process.stdout.write(`=== Etapa ${numero}: ${e.nome} -> ${r.status} (${r.motivo}) ===\n`);
    if (r.status === 'VERMELHO') { parou = true; process.stdout.write(`${cfg.codigoFalha}\n`); }
  });
  relatorio.fim = new Date().toISOString();
  relatorio.resultado = parou ? 'VERMELHO' : 'VERDE';
  fs.mkdirSync(path.dirname(relatorioArq), { recursive: true });
  fs.writeFileSync(relatorioArq, `${JSON.stringify(relatorio, null, 1)}\n`);
  return parou ? 1 : 0;
}

module.exports = { NODE_TEST, executarEsteira, resolverPortas, trocarMarcadores, argumento };
