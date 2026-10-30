#!/usr/bin/env node
'use strict';

/**
 * Esteira de CI das integrações (M9-D254): roda as etapas em ordem e PARA na primeira vermelha (as seguintes ficam NAO_RODOU). Sem opção, roda as etapas 1 a 9 (todo pull request e merge);
 * `--release` roda as etapas 10 a 13 de UM provider (INT_CI_PROVIDER), em tag de release. A etapa 13 não executa comando e NUNCA faz deploy: marca AGUARDANDO_APROVACAO e habilita o botão
 * de aprovação do Patrick, que é quem executa o deploy. A ordem e os nomes são os do livro (lib/estagios.js recusa qualquer outra). Etapa de banco recusa rodar fora de banco descartável.
 *
 *   node scripts/int-ci/executar.js [--release] [--etapas arquivo.json] [--log arquivo] [--relatorio arquivo.json] [--de N] [--ate N]
 *
 * Sai com 0 só se todas as etapas pedidas passaram (a 13 aguardando aprovação conta como cumprida). Etapa vermelha imprime INTEGRATION_CI_STAGE_FAILED.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const E = require('./lib/estagios');

const FLAGS = ['release'];
const VALORES = ['etapas', 'log', 'relatorio', 'de', 'ate'];

function argumentos(argv) {
  const a = { etapas: path.join(__dirname, 'estagios.json'), release: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (FLAGS.includes(k)) { a[k] = true; continue; }
    if (!VALORES.includes(k) || argv[i + 1] === undefined) throw new E.EsteiraInvalida(`argumento desconhecido: ${argv[i]}`);
    a[k] = ['de', 'ate'].includes(k) ? Number(argv[i + 1]) : argv[i + 1];
    i += 1;
  }
  const primeira = a.release ? E.ULTIMA_DE_PR + 1 : 1;
  const ultima = a.release ? E.ETAPAS_DO_LIVRO.length : E.ULTIMA_DE_PR;
  return { ...a, de: a.de || primeira, ate: a.ate || ultima };
}

function escritor(log) {
  const fd = log ? fs.openSync(log, 'a') : null;
  const escrever = (texto) => { process.stdout.write(texto); if (fd !== null) fs.writeSync(fd, texto); };
  return { escrever, fechar: () => { if (fd !== null) fs.closeSync(fd); } };
}

/** O `{provider}` de um argumento vira o provider da tag de release; sem ele a etapa de release não tem como saber o que liberar. */
function substituir(argv, provider) {
  return argv.map((t) => String(t).replace(/\{provider\}/g, provider));
}

function executarComando({ argv, env }, saida) {
  return new Promise((resolve) => {
    const filho = spawn(argv[0], argv.slice(1), { cwd: E.ROOT, env: { ...process.env, DRILL_PG_PORT: String(55000 + Math.floor(Math.random() * 2000)), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    filho.stdout.on('data', (d) => saida.escrever(d.toString()));
    filho.stderr.on('data', (d) => saida.escrever(d.toString()));
    filho.on('error', (err) => { saida.escrever(`erro ao iniciar ${argv[0]}: ${err.message}\n`); resolve(127); });
    filho.on('close', (codigo) => resolve(codigo === null ? 1 : codigo));
  });
}

async function rodarEtapa(e, saida) {
  if (e.numero === 13) {
    saida.escrever(`AGUARDANDO APROVAÇÃO HUMANA: o CI não faz deploy em produção; o botão de liberação do provider ${process.env.INT_CI_PROVIDER || '(não informado)'} fica habilitado para o Patrick.\n`);
    return 'AGUARDANDO_APROVACAO';
  }
  if (e.banco && process.env.DISPOSABLE_DB !== '1') {
    saida.escrever('RECUSADO: etapa de banco só roda em banco descartável (node scripts/withDisposableDb.js -- ...).\n');
    return 'VERMELHO';
  }
  const provider = process.env.INT_CI_PROVIDER;
  if (e.tipo === 'release' && !provider) {
    saida.escrever('RECUSADO: etapa de release exige INT_CI_PROVIDER (o provider da tag).\n');
    return 'VERMELHO';
  }
  for (const c of E.comandosDaEtapa(e)) {
    const cmd = { argv: substituir(c.argv, provider || ''), env: c.env };
    saida.escrever(`$ ${cmd.argv.join(' ')}\n`);
    if (await executarComando(cmd, saida) !== 0) return 'VERMELHO';
  }
  return 'VERDE';
}

function commitAtual() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: E.ROOT, encoding: 'utf8' });
  return process.env.GITHUB_SHA || (r.status === 0 ? r.stdout.trim() : 'local');
}

async function main() {
  const a = argumentos(process.argv.slice(2));
  const etapas = E.carregar(a.etapas);
  // Os JUnit e o registro de conexões externas (M9-D258) são de UMA execução das etapas de teste: quem começa na etapa 3 ou antes zera os da execução anterior.
  const pasta = path.join(E.ROOT, E.RELATORIOS);
  if (a.de <= 3) fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(pasta, { recursive: true });
  const saida = escritor(a.log);
  const relatorio = { commit: commitAtual(), inicio: new Date().toISOString(), modo: a.release ? 'release' : 'pull-request', provider: process.env.INT_CI_PROVIDER || null, etapas: [] };
  let vermelho = false;
  for (const e of etapas) {
    if (e.numero < a.de || e.numero > a.ate) continue;
    const item = { numero: e.numero, nome: e.nome, tipo: e.tipo, status: 'NAO_RODOU', duracaoMs: 0 };
    relatorio.etapas.push(item);
    if (vermelho) continue;
    saida.escrever(`# etapa ${e.numero}: ${e.nome}\n`);
    const t0 = Date.now();
    try {
      item.status = await rodarEtapa(e, saida);
    } catch (err) {
      saida.escrever(`falha na esteira: ${err.message}\n`);
      item.status = 'VERMELHO';
    }
    item.duracaoMs = Date.now() - t0;
    saida.escrever(`# etapa ${e.numero}: ${e.nome} => ${item.status}\n`);
    if (item.status === 'VERMELHO') {
      vermelho = true;
      item.codigo = E.CODIGO_FALHA;
      saida.escrever(`${E.CODIGO_FALHA} ${E.MENSAGEM_FALHA} (etapa ${e.numero}: ${e.nome})\n`);
    }
  }
  relatorio.resultado = vermelho ? 'VERMELHO' : 'VERDE';
  relatorio.aprovacaoHabilitada = !vermelho && relatorio.etapas.some((x) => x.numero === 13 && x.status === 'AGUARDANDO_APROVACAO');
  saida.escrever(`# esteira das integrações: ${relatorio.resultado}\n`);
  if (a.relatorio) fs.writeFileSync(a.relatorio, `${JSON.stringify(relatorio, null, 2)}\n`);
  saida.fechar();
  return vermelho ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`esteira recusada: ${err.message}`); process.exit(2); });
