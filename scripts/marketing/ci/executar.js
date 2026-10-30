#!/usr/bin/env node
'use strict';

/**
 * Esteira de CI do Marketing (M9-D438): roda os estágios em ordem e PARA no primeiro vermelho (os seguintes ficam NAO_RODOU). Sem opção roda os estágios 1 a 11 (todo push e pull request);
 * `--entrega` roda os estágios 12 a 14 (branch de entrega). A ordem e os nomes são os do livro (lib/estagios.js recusa qualquer outra). Estágio com banco recusa rodar fora de banco descartável.
 *
 *   node scripts/marketing/ci/executar.js [--entrega] [--estagios arquivo.json] [--log arquivo] [--relatorio arquivo.json] [--de N] [--ate N]
 *
 * Sai com 0 só se todos os estágios pedidos passaram. Estágio vermelho imprime MKT_CI_STAGE_FAILED.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const E = require('./lib/estagios');

const VALORES = ['estagios', 'log', 'relatorio', 'de', 'ate'];

function argumentos(argv) {
  const a = { estagios: path.join(__dirname, 'estagios.json'), entrega: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'entrega') { a.entrega = true; continue; }
    if (!VALORES.includes(k) || argv[i + 1] === undefined) throw new E.EsteiraInvalida(`argumento desconhecido: ${argv[i]}`);
    a[k] = ['de', 'ate'].includes(k) ? Number(argv[i + 1]) : argv[i + 1];
    i += 1;
  }
  return { ...a, de: a.de || (a.entrega ? E.ULTIMO_DE_PUSH + 1 : 1), ate: a.ate || (a.entrega ? E.ESTAGIOS_DO_LIVRO.length : E.ULTIMO_DE_PUSH) };
}

function escritor(log) {
  const fd = log ? fs.openSync(log, 'a') : null;
  return { escrever: (texto) => { process.stdout.write(texto); if (fd !== null) fs.writeSync(fd, texto); }, fechar: () => { if (fd !== null) fs.closeSync(fd); } };
}

function executarComando({ argv, env }, saida) {
  return new Promise((resolve) => {
    const filho = spawn(argv[0], argv.slice(1), { cwd: E.ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    filho.stdout.on('data', (d) => saida.escrever(d.toString()));
    filho.stderr.on('data', (d) => saida.escrever(d.toString()));
    filho.on('error', (err) => { saida.escrever(`erro ao iniciar ${argv[0]}: ${err.message}\n`); resolve(127); });
    filho.on('close', (codigo) => resolve(codigo === null ? 1 : codigo));
  });
}

async function rodarEstagio(e, saida) {
  if (e.banco && process.env.DISPOSABLE_DB !== '1') {
    saida.escrever('RECUSADO: estágio de banco só roda em banco descartável (node scripts/withDisposableDb.js -- ...).\n');
    return 'VERMELHO';
  }
  const ausentes = E.testesExigidosAusentes(e);
  if (ausentes.length) {
    saida.escrever(`TESTE EXIGIDO AUSENTE: ${ausentes.join(', ')} (o estágio ${e.numero} exige estes testes nos arquivos dos seus padrões; apagar ou renomear reprova a esteira).\n`);
    return 'VERMELHO';
  }
  for (const c of E.comandosDaEtapa(e)) {
    saida.escrever(`$ ${c.argv.join(' ')}\n`);
    if (await executarComando(c, saida) !== 0) return 'VERMELHO';
  }
  return 'VERDE';
}

function commitAtual() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: E.ROOT, encoding: 'utf8' });
  return process.env.GITHUB_SHA || (r.status === 0 ? r.stdout.trim() : 'local');
}

async function main() {
  const a = argumentos(process.argv.slice(2));
  const estagios = E.carregar(a.estagios);
  const saida = escritor(a.log);
  const relatorio = { commit: commitAtual(), inicio: new Date().toISOString(), modo: a.entrega ? 'entrega' : 'push', estagios: [] };
  let vermelho = false;
  for (const e of estagios) {
    if (e.numero < a.de || e.numero > a.ate) continue;
    const item = { numero: e.numero, nome: e.nome, tipo: e.tipo, status: 'NAO_RODOU', duracaoMs: 0 };
    relatorio.estagios.push(item);
    if (vermelho) continue;
    saida.escrever(`# estágio ${e.numero}: ${e.nome}\n`);
    const t0 = Date.now();
    try {
      item.status = await rodarEstagio(e, saida);
    } catch (err) {
      saida.escrever(`falha na esteira: ${err.message}\n`);
      item.status = 'VERMELHO';
    }
    item.duracaoMs = Date.now() - t0;
    saida.escrever(`# estágio ${e.numero}: ${e.nome} => ${item.status}\n`);
    if (item.status === 'VERMELHO') {
      vermelho = true;
      item.codigo = E.CODIGO_FALHA;
      saida.escrever(`${E.CODIGO_FALHA} ${E.MENSAGEM_FALHA} (estágio ${e.numero}: ${e.nome})\n`);
    }
  }
  relatorio.resultado = vermelho ? 'VERMELHO' : 'VERDE';
  saida.escrever(`# esteira do marketing: ${relatorio.resultado}\n`);
  if (a.relatorio) fs.writeFileSync(a.relatorio, `${JSON.stringify(relatorio, null, 2)}\n`);
  saida.fechar();
  return vermelho ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`esteira recusada: ${err.message}`); process.exit(2); });
