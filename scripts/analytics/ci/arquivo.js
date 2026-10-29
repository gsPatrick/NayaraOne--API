'use strict';

/** M9-D705 — arquivo do resultado de cada etapa (log + resumo JSON). Segredo nunca entra: os padrões da varredura de segredo (M9-D246) são mascarados. */
const fs = require('node:fs');
const path = require('node:path');
const { PATTERNS } = require('../../lib/secretScanPatterns');

function redigir(texto) {
  let out = String(texto);
  for (const { re } of PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), '[REDIGIDO]');
  return out;
}

function gravarLog(saida, etapa, texto) {
  fs.mkdirSync(saida, { recursive: true });
  const nome = `etapa-${String(etapa.n).padStart(2, '0')}-${etapa.chave}.log`;
  fs.writeFileSync(path.join(saida, nome), redigir(texto));
  return nome;
}

function gravarResumo(saida, resumo) {
  fs.mkdirSync(saida, { recursive: true });
  fs.writeFileSync(path.join(saida, 'resumo.json'), `${JSON.stringify(resumo, null, 2)}\n`);
}

module.exports = { redigir, gravarLog, gravarResumo };
