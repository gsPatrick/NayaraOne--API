'use strict';

const path = require('node:path');
const { scanBoundaries } = require('../integrationBoundaries');
const { API_ROOT, violation } = require('./common');

/** Regra 1 do livro: "Não importar SDK externo em domínio/application service". Qualquer pacote da denylist da M9-D210 importado fora de `providers/**` reprova. */
function scan({ root = API_ROOT } = {}) {
  return scanBoundaries({ srcRoot: path.join(root, 'src') }).filter((v) => v.code === 'ARCH_SDK_OUTSIDE_ADAPTER').map((v) => violation(1, v.file, v.line, v.message, v.snippet));
}

module.exports = { rule: 1, name: 'sdk_fora_do_adapter', scan };
