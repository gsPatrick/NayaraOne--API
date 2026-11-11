#!/usr/bin/env node
'use strict';

/**
 * Esteira de CI do Financeiro (Marco 4, Guia do Marcelo §17): roda os estágios em ordem e PARA no primeiro vermelho (os seguintes ficam NAO_RODOU).
 *   sem opção     -> estágios de push (1 a 13, 15 e 16)
 *   --entrega     -> estágio 14 (deploy_LAB, branch de entrega)
 *   --aprovacao   -> estágio 17 (production_approval, depois da aprovação manual do environment "production"; nunca faz deploy)
 *   --todos       -> 1 a 17 em ordem (execução local completa da esteira)
 *   --de N --ate N restringe a faixa.
 *
 *   node scripts/financeiro/ci/executar.js [--entrega|--aprovacao|--todos] [--estagios arquivo.json] [--log arquivo] [--relatorio arquivo.json] [--de N] [--ate N]
 *
 * Sai com 0 só se todos os estágios pedidos passaram. Estágio vermelho imprime FIN_CI_STAGE_FAILED. Estágio com banco recusa rodar fora de banco descartável.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const E = require('./lib/estagios');

const VALORES = ['estagios', 'log', 'relatorio', 'de', 'ate'];
const MODOS = ['entrega', 'aprovacao', 'todos'];

function argumentos(argv) {
  const a = { estagios: path.join(__dirname, 'estagios.json'), modo: 'push' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (MODOS.includes(k)) { a.modo = k; continue; }
    if (!VALORES.includes(k) || argv[i + 1] === undefined) throw new E.EsteiraInvalida(`argumento desconhecido: ${argv[i]}`);
    a[k] = ['de', 'ate'].includes(k) ? Number(argv[i + 1]) : argv[i + 1];
    i += 1;
  }
  return { ...a, de: a.de || 1, ate: a.ate || E.ESTAGIOS_DO_LIVRO.length };
}

const doModo = (modo, e) => modo === 'todos' || e.tipo === modo;

function escritor(log) {
  const fd = log ? fs.openSync(log, 'a') : null;
  return { escrever: (texto) => { process.stdout.write(texto); if (fd !== null) fs.writeSync(fd, texto); }, fechar: () => { if (fd !== null) fs.closeSync(fd); } };
}

// Nada de string de conexão no log: a URL do banco descartável (com a senha local do runtime) vira um marcador.
const ocultar = (texto) => texto.replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, '<url do banco descartável>');

function executarComando({ argv, env }, saida) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.join(E.ROOT, E.RELATORIOS), { recursive: true });
    const filho = spawn(argv[0], argv.slice(1), { cwd: E.ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    filho.stdout.on('data', (d) => saida.escrever(ocultar(d.toString())));
    filho.stderr.on('data', (d) => saida.escrever(ocultar(d.toString())));
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
    saida.escrever(`$ ${ocultar(c.argv.join(' '))}\n`);
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
  const relatorio = { commit: commitAtual(), inicio: new Date().toISOString(), modo: a.modo, estagios: [] };
  let vermelho = false;
  for (const e of estagios) {
    if (e.numero < a.de || e.numero > a.ate || !doModo(a.modo, e)) continue;
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
  relatorio.fim = new Date().toISOString();
  relatorio.resultado = vermelho ? 'VERMELHO' : 'VERDE';
  saida.escrever(`# esteira do financeiro: ${relatorio.resultado}\n`);
  if (a.relatorio) fs.writeFileSync(a.relatorio, `${JSON.stringify(relatorio, null, 2)}\n`);
  saida.fechar();
  return vermelho ? 1 : 0;
}

main().then((c) => process.exit(c), (err) => { console.error(`esteira recusada: ${err.message}`); process.exit(2); });
