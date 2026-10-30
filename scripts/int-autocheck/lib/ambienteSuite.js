'use strict';

/** Arquivos de teste que a execução offline de cada escopo tem de cobrir (M9-D258): as etapas 3 a 9 da esteira das integrações (única fonte: estagios.json) e a pasta da IA. */
const fs = require('node:fs');
const path = require('node:path');

function arquivosDaPasta(dir, raiz, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivosDaPasta(p, raiz, acc);
    else if (/\.test\.js$/.test(e.name)) acc.push(path.relative(raiz, p).split(path.sep).join('/'));
  }
  return acc;
}

function arquivosDaSuite(escopo, base) {
  if (escopo === 'ia-nay') return arquivosDaPasta(path.join(base, 'test/marco9/ia'), base).sort();
  const E = require(path.join(base, 'scripts/int-ci/lib/estagios'));
  const etapas = E.carregar(path.join(base, 'scripts/int-ci/estagios.json')).filter((e) => e.numero >= 3 && e.numero <= E.ULTIMA_DE_PR);
  const arquivos = etapas.flatMap((e) => E.comandosDaEtapa(e, base)).flatMap((c) => c.argv.filter((a) => a.endsWith('.test.js')));
  return [...new Set(arquivos)].sort();
}

module.exports = { arquivosDaSuite, arquivosDaPasta };
