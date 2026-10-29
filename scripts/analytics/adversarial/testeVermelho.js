'use strict';

/**
 * M9-D704 (3.3, regra de prova) — reconstrói a prova de "teste escrito antes do código": para cada teste nomeado dos 10 itens do Guia, acha por
 * `git log -S` o commit que o criou, extrai (sem tocar no repositório de trabalho) a árvore do commit ANTERIOR, põe por cima os testes do commit
 * do teste e roda: o teste nomeado precisa FALHAR no código anterior. Grava commit anterior, commit do código e a saída vermelha. Banco descartável:
 *   node scripts/withDisposableDb.js -- node scripts/analytics/adversarial/testeVermelho.js [--saida docs/evidencias/analytics/testes-primeiro.json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TESTES_PRIMEIRO } = require('../../../test/marco9/_helpers/m9d704Mapa');
const { executarTeste } = require('../../../test/marco9/_helpers/m9d704Executa');
const { redigir } = require('../ci/arquivo');

const ROOT = path.join(__dirname, '..', '..', '..');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Primeiro commit que acrescentou `nome` ao arquivo (pickaxe), e o commit anterior a ele. */
function commitQueCriou(arquivo, nome) {
  const lista = git('log', '-S', `test('${nome}'`, '--format=%h', '--', arquivo).stdout.trim().split('\n').filter(Boolean);
  const codigo = lista[lista.length - 1];
  return { codigo, anterior: git('rev-parse', '--short', `${codigo}^`).stdout.trim() };
}

function provar(t) {
  const { codigo, anterior } = commitQueCriou(t.arquivo, t.nome);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d704-vermelho-'));
  try {
    const raiz = ['src', 'scripts', 'migrations', 'test', 'app.js', 'package.json', '.sequelizerc'];
    const arq = spawnSync('git', ['archive', '--format=tar', anterior, ...raiz], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    spawnSync('tar', ['-x', '-C', dir], { input: arq.stdout, maxBuffer: 256 * 1024 * 1024 });
    const testes = spawnSync('git', ['archive', '--format=tar', codigo, 'test'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    spawnSync('tar', ['-x', '-C', dir], { input: testes.stdout, maxBuffer: 256 * 1024 * 1024 });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const r = executarTeste(t, { raiz: dir });
    const falha = r.output.split('\n').filter((l) => /^not ok|Cannot find module|Error|rror \[/.test(l.trim())).slice(0, 3).join(' | ');
    const limpa = redigir(falha || r.output.slice(-300)).replace(/\/[^\s)|]*m9d704-vermelho-[^/\s)|]*/g, '<arvore-anterior>').slice(0, 500);
    return { ...t, codigo, anterior, vermelho: !r.ok, saida: limpa };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const i = process.argv.indexOf('--saida');
  const saida = i >= 0 ? path.resolve(process.argv[i + 1]) : null;
  const donas = {};
  for (const t of TESTES_PRIMEIRO) {
    const p = provar(t);
    console.log(`${p.dona} item ${t.item} "${t.nome}": ${p.vermelho ? 'VERMELHO no código anterior' : 'PASSOU no código anterior (sem prova)'} (${p.anterior} -> ${p.codigo})`);
    const d = donas[t.dona] || (donas[t.dona] = { commitAnterior: p.anterior, commitCodigo: p.codigo, testes: [], vermelho: true, saidaVermelha: '' });
    d.testes.push(t.nome);
    d.vermelho = d.vermelho && p.vermelho;
    if (!d.saidaVermelha || p.codigo === d.commitCodigo) d.saidaVermelha = p.saida;
  }
  if (saida) {
    fs.mkdirSync(path.dirname(saida), { recursive: true });
    fs.writeFileSync(saida, `${JSON.stringify({ gerado: new Date().toISOString(), donas }, null, 2)}\n`);
  }
  process.exitCode = Object.values(donas).every((d) => d.vermelho) ? 0 : 1;
}

main();
