#!/usr/bin/env node
'use strict';

/**
 * Esteira de CI da NAY (M9-D044): roda os estágios 1 a 12 em ordem e PARA no primeiro vermelho; os estágios 13 a 16 (DEV, LAB, red-team,
 * production approval) só conferem o registro humano em ai.release_gates. Nada é pulado nem reordenado: a ordem e os nomes são os do livro
 * (lib/estagios.js recusa qualquer outra). Estágio de banco recusa rodar fora de banco descartável (DISPOSABLE_DB=1).
 *
 *   node scripts/ai-ci/executar.js [--estagios arquivo.json] [--log arquivo] [--relatorio arquivo.json] [--de N] [--ate N]
 *
 * Variáveis: AI_CI_RELEASE_DATABASE_URL (leitura de ai.release_gates, estágios 13 a 16; segredo do CI), DRILL_PG_PORT (sorteada para o banco
 * descartável aninhado do estágio 7/14). Sai com 0 só se todos os estágios pedidos passaram.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const E = require('./lib/estagios');
const portoes = require('./lib/portoes');

function argumentos(argv) {
  const a = { estagios: path.join(__dirname, 'estagios.json'), de: 1, ate: E.ESTAGIOS_DO_LIVRO.length };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (!['estagios', 'log', 'relatorio', 'de', 'ate'].includes(k) || argv[i + 1] === undefined) throw new E.EsteiraInvalida(`argumento desconhecido: ${argv[i]}`);
    a[k] = ['de', 'ate'].includes(k) ? Number(argv[i + 1]) : argv[i + 1];
  }
  return a;
}

function escritor(log) {
  const fd = log ? fs.openSync(log, 'a') : null;
  const escrever = (texto) => { process.stdout.write(texto); if (fd !== null) fs.writeSync(fd, texto); };
  return { escrever, fechar: () => { if (fd !== null) fs.closeSync(fd); } };
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

async function estagioAutomatico(e, saida) {
  if (e.banco && process.env.DISPOSABLE_DB !== '1') {
    saida.escrever('RECUSADO: estágio de banco só roda em banco descartável (node scripts/withDisposableDb.js -- ...).\n');
    return false;
  }
  for (const c of E.comandosDoEstagio(e)) {
    saida.escrever(`$ ${c.argv.join(' ')}\n`);
    if (await executarComando(c, saida) !== 0) return false;
  }
  return true;
}

async function estagioRegistro(e, saida) {
  const { consulta, fechar } = await portoes.abrirConsulta(process.env.AI_CI_RELEASE_DATABASE_URL).catch((err) => {
    saida.escrever(`sem conexão com o ambiente de liberação (${err.code || 'erro'})\n`);
    return { consulta: null, fechar: async () => {} };
  });
  try {
    const r = await portoes.verificarPortao(consulta, e.item, { exigeEvidencia: Boolean(e.exigeEvidencia) });
    saida.escrever(`${r.ok ? 'REGISTRADO' : 'SEM REGISTRO'}: ${r.motivo}\n`);
    if (!r.ok) return false;
  } finally {
    await fechar();
  }
  for (const c of e.depois || []) {
    const cmd = { argv: c.argv, env: c.env || {} };
    saida.escrever(`$ ${cmd.argv.join(' ')}\n`);
    if (await executarComando(cmd, saida) !== 0) return false;
  }
  return true;
}

function commitAtual() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: E.ROOT, encoding: 'utf8' });
  return process.env.GITHUB_SHA || (r.status === 0 ? r.stdout.trim() : 'local');
}

async function main() {
  const a = argumentos(process.argv.slice(2));
  const estagios = E.carregar(a.estagios);
  const saida = escritor(a.log);
  const relatorio = { commit: commitAtual(), inicio: new Date().toISOString(), estagios: [] };
  let vermelho = false;
  for (const e of estagios) {
    if (e.numero < a.de || e.numero > a.ate) continue;
    const item = { numero: e.numero, nome: e.nome, tipo: e.tipo, status: 'NAO_RODOU', duracaoMs: 0 };
    relatorio.estagios.push(item);
    if (vermelho) continue;
    saida.escrever(`# estagio ${e.numero}: ${e.nome}\n`);
    const t0 = Date.now();
    let ok = false;
    try {
      ok = e.tipo === 'automatico' ? await estagioAutomatico(e, saida) : await estagioRegistro(e, saida);
    } catch (err) {
      saida.escrever(`falha na esteira: ${err.message}\n`);
    }
    item.duracaoMs = Date.now() - t0;
    item.status = ok ? 'VERDE' : 'VERMELHO';
    saida.escrever(`# estagio ${e.numero}: ${e.nome} => ${item.status}\n`);
    if (!ok) vermelho = true;
  }
  relatorio.resultado = vermelho ? 'VERMELHO' : 'VERDE';
  saida.escrever(`# esteira da NAY: ${relatorio.resultado}\n`);
  if (a.relatorio) fs.writeFileSync(a.relatorio, `${JSON.stringify(relatorio, null, 2)}\n`);
  saida.fechar();
  return vermelho ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`esteira recusada: ${err.message}`); process.exit(2); });
