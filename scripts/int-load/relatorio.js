'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PASTA_PADRAO = path.join(__dirname, '..', '..', 'docs', 'evidencias', 'integracoes', 'carga');

/** Arquiva o relatório da carga (JSON) em `pasta` e devolve o caminho. Sem segredo, endereço nem dado pessoal. */
function gravarRelatorio(relatorio, pasta = PASTA_PADRAO) {
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, `carga-${relatorio.executadoEm.slice(0, 10)}.json`);
  fs.writeFileSync(arquivo, `${JSON.stringify(relatorio, null, 2)}\n`);
  return arquivo;
}

module.exports = { gravarRelatorio, PASTA_PADRAO };
