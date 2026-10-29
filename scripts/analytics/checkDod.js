#!/usr/bin/env node
'use strict';

/**
 * M9-D707 — portão automático do Definition of Done do BI: os 11 itens do livro (§22) com SIM/NÃO e a razão de cada NÃO. Termina com código 1
 * se algum item for NÃO. Os testes rodam em banco descartável (127.0.0.1): fora dele o script se reexecuta dentro de `withDisposableDb.js`;
 * nunca toca a homologação. NÃO inclui o aceite dos owners para produção (M9-D708).
 * Uso: node scripts/analytics/checkDod.js [--demandas <pasta>] [--esteira <pasta>] [--idade-max-horas 24] [--json]
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ITENS } = require('./dod/itens');
const { avaliarDod } = require('./dod/avaliar');
const { criarVerificador } = require('./dod/verificador');
const { criarExecutor, API_ROOT } = require('./dod/executor');
const { formatarMatriz, resumoDeReprovacao } = require('./dod/relatorio');
const { carregarDemandas, pastaPadrao } = require('./sprints/demandasMd');
const { PADRAO_DIR, IDADE_PADRAO_HORAS } = require('./sprints/esteira');
const { bancoDescartavelAtivo, ambienteDosComandos, portaAleatoria } = require('./ci/ambiente');

const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao; };

async function main() {
  const pasta = arg('--demandas', pastaPadrao());
  const demandas = carregarDemandas(pasta);
  const verificar = criarVerificador(pasta);
  if (!bancoDescartavelAtivo()) {
    const reexec = [path.join('scripts', 'withDisposableDb.js'), '--port', String(portaAleatoria()), '--', process.execPath, __filename, ...process.argv.slice(2)];
    process.exit(spawnSync(process.execPath, reexec, { cwd: API_ROOT, stdio: 'inherit', env: ambienteDosComandos() }).status ?? 1);
  }
  const r = await avaliarDod(ITENS, {
    demandas, raiz: API_ROOT, verificar, executar: criarExecutor(ambienteDosComandos()),
    esteira: { dir: arg('--esteira', PADRAO_DIR), idadeMaximaHoras: Number(arg('--idade-max-horas', IDADE_PADRAO_HORAS)) },
  });
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : formatarMatriz(r));
  if (!r.ok) { console.error(`\n${resumoDeReprovacao(r)}`); process.exitCode = 1; } else console.log('\nDoD do BI aprovado: os 11 itens estão SIM.');
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
