#!/usr/bin/env node
'use strict';
/**
 * Etapa 18 da esteira do jurídico (Guia M5 §17 production_approval; Guia §22 "Produção apenas depois de gates reais,
 * falhas, restore e pentest"): o PORTÃO de produção. Lê o relatório da execução e as evidências que as etapas deixaram
 * (resultados de teste por etapa, relatório do drill de restore, relatório do pentest), aplica gateRegras.js e grava
 * <evidencias>/portao-producao.json. Sai 0 só se a produção pode ser pedida; sai 1 com a lista de bloqueios.
 * Nunca faz deploy: no GitHub, a aprovação humana é o environment juridico-aprovacao (job aprovacao-producao, só em tag).
 *
 *   node scripts/ci-juridico/gateProducao.js --relatorio <esteira.json> --evidencias <pasta> [--commit <sha>]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ETAPAS, REPORTER } = require('./etapas');
const { avaliarPortao } = require('./gateRegras');

const ROOT = path.resolve(__dirname, '..', '..');
const arg = (argv, nome) => { const i = argv.indexOf(nome); return i >= 0 ? argv[i + 1] : null; };

function lerJson(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (_) { return null; }
}

function lerJsonl(arquivo) {
  return fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return { arquivo, nome: 'linha ilegível no resultado', status: 'fail', motivo: l.slice(0, 120) }; }
  });
}

/** Etapas cujo comando grava resultado de teste (reporter da esteira), como o executor as nomeia: NN-nome. */
function etapasDeTeste() {
  return ETAPAS.map((e, i) => ({ e, id: `${String(i + 1).padStart(2, '0')}-${e.nome}` }))
    .filter(({ e }) => e.comandos.some((c) => c.includes(`--test-reporter=${REPORTER}`)))
    .map(({ id }) => id);
}

function coletar(evidencias) {
  const dirRestore = path.join(evidencias, 'restore');
  const restores = fs.existsSync(dirRestore)
    ? fs.readdirSync(dirRestore).filter((f) => f.endsWith('.json')).map((f) => ({ arquivo: `restore/${f}`, dados: lerJson(path.join(dirRestore, f)) })).filter((r) => r.dados)
    : [];
  const pentest = lerJson(path.join(evidencias, 'pentest', 'RELATORIO_PENTEST_M5.json'));
  const dirTestes = path.join(evidencias, 'testes');
  const testes = {};
  if (fs.existsSync(dirTestes)) {
    for (const f of fs.readdirSync(dirTestes).filter((x) => x.endsWith('.jsonl'))) testes[f.replace(/\.jsonl$/, '')] = lerJsonl(path.join(dirTestes, f));
  }
  return { restores, pentest, testes };
}

function commitAtual(argv) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return arg(argv, '--commit') || process.env.GITHUB_SHA || (r.status === 0 ? r.stdout.trim() : null);
}

function main(argv = process.argv.slice(2)) {
  const relatorioArq = arg(argv, '--relatorio');
  const evidencias = arg(argv, '--evidencias');
  if (!relatorioArq || !evidencias) { console.error('uso: gateProducao.js --relatorio <esteira.json> --evidencias <pasta> [--commit <sha>]'); return 2; }
  const commit = commitAtual(argv);
  const resultado = avaliarPortao({ commit, relatorio: lerJson(relatorioArq), ...coletar(evidencias), etapasDeTeste: etapasDeTeste() });
  const saida = { portao: 'production_approval (Guia M5 §17/§22)', quando: new Date().toISOString(), ...resultado };
  fs.mkdirSync(evidencias, { recursive: true });
  fs.writeFileSync(path.join(evidencias, 'portao-producao.json'), `${JSON.stringify(saida, null, 1)}\n`);
  const t = resultado.resumo.testes;
  console.log(`[portão de produção] commit ${commit}; etapas 1-17 verdes: ${resultado.resumo.etapasVerdes}/17; testes: ${t.pass} pass, ${t.fail} fail, ${t.skip} skip, ${t.todo} todo`);
  for (const r of resultado.resumo.restore) console.log(`[portão de produção] restore ${r.arquivo}: ${r.aprovadas}/${r.total}, exitCode ${r.exitCode}, dirty ${r.dirty}, commit ${r.commit}`);
  if (resultado.resumo.pentest) console.log(`[portão de produção] pentest: ${resultado.resumo.pentest.rotas} rotas, ${resultado.resumo.pentest.ataques} ataques, ${JSON.stringify(resultado.resumo.pentest.porGravidade)}`);
  if (resultado.liberado) {
    console.log('[portão de produção] LIBERADO: gates reais, falhas, restore e pentest verdes no mesmo commit, árvore limpa, nenhuma falha aberta.');
    return 0;
  }
  console.error(`[portão de produção] BLOQUEADO (${resultado.bloqueios.length}):`);
  for (const b of resultado.bloqueios) console.error(`  ${b.codigo}: ${b.detalhe}`);
  console.error('LEGAL_PRODUCTION_GATE_BLOCKED');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, coletar, etapasDeTeste };
