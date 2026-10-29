'use strict';

/** M9-D707 — executa os comandos do DoD (spawn, sem shell); comando com `banco: true` só roda em banco descartável em 127.0.0.1. */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bancoDescartavelAtivo, portaAleatoria } = require('../ci/ambiente');

const API_ROOT = path.join(__dirname, '..', '..', '..');

function spawnar(comando, env) {
  return new Promise((resolve) => {
    let output = '';
    const filho = spawn(comando.cmd === 'node' ? process.execPath : comando.cmd, comando.args, { cwd: API_ROOT, env, shell: false });
    filho.stdout.on('data', (d) => { output += d; });
    filho.stderr.on('data', (d) => { output += d; });
    filho.on('error', (e) => resolve({ code: 127, output: `${output}${e.message}` }));
    filho.on('close', (code) => resolve({ code: code === null ? 1 : code, output }));
  });
}

/** Comando `isolado`: banco descartável novo (e semeado) só para esse comando, via `withDisposableDb.js` + `rodarIsolado.js`. */
const comandoIsolado = (comando) => ({
  cmd: 'node',
  args: [path.join('scripts', 'withDisposableDb.js'), '--port', String(portaAleatoria()), '--', process.execPath, path.join('scripts', 'analytics', 'dod', 'rodarIsolado.js'), ...comando.args],
});

function criarExecutor(env) {
  let semeado = false;
  return async (comando) => {
    if (comando.banco) {
      if (!bancoDescartavelAtivo(env)) return { code: 1, output: 'Comando recusado: o banco não é descartável em 127.0.0.1.' };
      if (comando.isolado) return spawnar(comandoIsolado(comando), env);
      if (!semeado) {
        semeado = true;
        const seed = await spawnar({ cmd: 'node', args: ['scripts/seed-ci-two-tenants.js'] }, env);
        if (seed.code !== 0) return { code: seed.code, output: `semente dos dois tenants falhou\n${seed.output}` };
      }
    }
    return spawnar(comando, env);
  };
}

module.exports = { criarExecutor, API_ROOT };
