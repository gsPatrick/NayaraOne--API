'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LeituraError } = require('./erros');

const RAIZ_API = path.resolve(__dirname, '..', '..', '..');
const CONFIG_PADRAO = path.join(RAIZ_API, 'docs', 'governance', 'dod-bloco-f.json');

/** Lê o JSON de configuração do fechamento (docs/governance/dod-bloco-f.json): arquivos, suítes e comandos de cada prova. Nada disso fica fixo no código. */
function lerConfig(arquivo = CONFIG_PADRAO) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (e) { throw new LeituraError(`não foi possível ler a configuração ${arquivo}: ${e.code || e.message}`); }
  for (const bloco of ['dry3', 'registry', 'lineage', 'dlp', 'manifest', 'adversarial']) {
    if (!cfg || typeof cfg[bloco] !== 'object' || cfg[bloco] === null) throw new LeituraError(`a configuração ${arquivo} não tem o bloco "${bloco}"`);
  }
  return cfg;
}

/** Caminho do JSON relativo à raiz da API (ou absoluto). */
const daRaiz = (caminho) => path.resolve(RAIZ_API, caminho);

module.exports = { lerConfig, daRaiz, RAIZ_API, CONFIG_PADRAO };
