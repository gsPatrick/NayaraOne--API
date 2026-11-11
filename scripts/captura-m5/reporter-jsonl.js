'use strict';
/**
 * Reporter do node:test que grava uma linha JSON por teste concluído (arquivo, nome, nível,
 * status, duração). Usado pela matriz do Marco 5 para amarrar cada requisito ao teste e ao
 * resultado medido no commit. Uso:
 *   node --test --test-reporter=./scripts/captura-m5/reporter-jsonl.js --test-reporter-destination=out.jsonl ...
 */
const path = require('node:path');

module.exports = async function* reporter(source) {
  const raiz = process.cwd();
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.details && d.details.type === 'suite') continue;
    const linha = {
      arquivo: d.file ? path.relative(raiz, d.file) : 'não informado',
      nome: d.name,
      nivel: d.nesting,
      status: ev.type === 'test:pass' ? (d.skip ? 'skip' : 'pass') : 'fail',
      ms: d.details && typeof d.details.duration_ms === 'number' ? Math.round(d.details.duration_ms * 1000) / 1000 : null,
    };
    if (ev.type === 'test:fail') linha.erro = String((d.details && d.details.error && d.details.error.message) || 'falhou').slice(0, 500);
    yield `${JSON.stringify(linha)}\n`;
  }
};
