#!/usr/bin/env node
'use strict';

/**
 * M9-D704 — executa as mutações do catálogo (uma por teste adversarial) e grava o resultado. Em banco descartável:
 *   node scripts/withDisposableDb.js -- node scripts/analytics/mutacaoAdversarial.js [--adv 1,2] [--saida docs/evidencias/analytics/mutacoes-adversariais.json] [--commit <hash>]
 * Sai com 1 se alguma mutação NÃO derrubar o teste (a proteção não estaria sendo vigiada).
 */
const fs = require('node:fs');
const path = require('node:path');
const { MUTACOES } = require('./adversarial/mutacoes');
const { aplicarMutacao } = require('./adversarial/mutar');
const { redigir } = require('./ci/arquivo');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const so = arg('--adv') ? arg('--adv').split(',').map(Number) : null;
const saida = arg('--saida') ? path.resolve(arg('--saida')) : null;
const commit = arg('--commit') || 'working-tree';

const resultados = [];
for (const m of MUTACOES.filter((x) => !so || so.includes(x.adv))) {
  const r = aplicarMutacao(m);
  const linha = (r.output.split('\n').find((l) => /^not ok/.test(l)) || '').trim().slice(0, 160);
  resultados.push({ adv: m.adv, arquivo: m.arquivo, protecao: m.protecao, falhou: r.falhou, originalIntacto: r.originalIntacto, commit, evidencia: redigir(linha) });
  console.log(`adv${String(m.adv).padStart(2, '0')} ${r.falhou ? 'FALHOU com a proteção removida (ok)' : 'PASSOU com a proteção removida (PROTEÇÃO NÃO VIGIADA)'} - ${m.protecao}`);
}
if (saida) {
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, `${JSON.stringify({ gerado: new Date().toISOString(), resultados }, null, 2)}\n`);
}
process.exitCode = resultados.every((r) => r.falhou) ? 0 : 1;
