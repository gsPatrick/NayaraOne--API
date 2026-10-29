#!/usr/bin/env node
'use strict';

/**
 * M9-D705 — roda a esteira do BI. Uso:
 *   node scripts/analytics/ci/run.js --fase pr|promocao|tudo [--saida docs/evidencias/ci/bi-pipeline] [--ambiente LAB|PRODUCAO]
 * Sem banco descartável ativo, o comando se reexecuta dentro de `scripts/withDisposableDb.js` (cluster local em 127.0.0.1, porta aleatória) e
 * semeia os dois tenants fictícios uma vez. Sai com 1 se alguma etapa reprovar. Nenhuma etapa escreve no banco compartilhado de homologação.
 */
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { runPipeline } = require('./pipeline');
const { ETAPAS } = require('./etapas');
const { bancoDescartavelAtivo, ambienteDosComandos, portaAleatoria } = require('./ambiente');

const API_ROOT = path.join(__dirname, '..', '..', '..');
const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao; };

function executarComando(comando, env) {
  return new Promise((resolve) => {
    let output = '';
    const filho = spawn(comando.cmd, comando.args, { cwd: API_ROOT, env, shell: false });
    filho.stdout.on('data', (d) => { output += d; });
    filho.stderr.on('data', (d) => { output += d; });
    filho.on('error', (e) => resolve({ code: 127, output: `${output}${e.message}` }));
    filho.on('close', (code) => resolve({ code: code === null ? 1 : code, output }));
  });
}

async function main() {
  const fase = arg('--fase', 'pr');
  const saida = path.resolve(API_ROOT, arg('--saida', path.join('docs', 'evidencias', 'ci', 'bi-pipeline')));
  const precisaBanco = ETAPAS.some((e) => (fase === 'tudo' || e.fase === fase) && e.comandos.some((c) => c.banco));
  if (precisaBanco && !bancoDescartavelAtivo()) {
    const reexec = [path.join('scripts', 'withDisposableDb.js'), '--port', String(portaAleatoria()), '--', process.execPath, __filename, ...process.argv.slice(2)];
    process.exit(spawnSync(process.execPath, reexec, { cwd: API_ROOT, stdio: 'inherit', env: ambienteDosComandos() }).status ?? 1);
  }
  const env = { ...ambienteDosComandos(), ANALYTICS_AMBIENTE_PIPELINE: arg('--ambiente', 'LAB') };
  let semeado = false;
  const executar = async (comando) => {
    if (comando.banco) {
      if (!bancoDescartavelAtivo()) return { code: 1, output: 'Comando de escrita recusado: o banco não é descartável em 127.0.0.1.' };
      if (!semeado) {
        semeado = true;
        const seed = await executarComando({ cmd: 'node', args: ['scripts/seed-ci-two-tenants.js'] }, env);
        if (seed.code !== 0) return { code: seed.code, output: `semente dos dois tenants falhou\n${seed.output}` };
      }
    }
    return executarComando(comando, env);
  };
  const r = await runPipeline({ fase, executar, saida });
  for (const e of r.etapas) console.log(`etapa ${String(e.n).padStart(2, '0')} ${e.livro}: ${e.status}${e.motivo && e.status !== 'FORA_DA_FASE' ? ` - ${e.motivo}` : ''}`);
  console.log(r.ok ? 'Pipeline do BI aprovado.' : 'Pipeline do BI REPROVADO: a promoção está bloqueada (ver resumo.json).');
  process.exitCode = r.ok ? 0 : 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
