'use strict';
/**
 * Reporter do node:test da esteira do jurídico (Guia M5 §17). Grava uma linha JSON por teste concluído com o status
 * real: pass, fail, skip ou todo. O portão de produção (etapa 18, scripts/ci-juridico/gateRegras.js) lê estas linhas:
 * teste que falhou, foi pulado ou ficou `todo` (defeito conhecido e ainda aberto) é "falha aberta" e bloqueia a produção.
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/ci-juridico/reporterEsteira.js --test-reporter-destination=<etapa>.jsonl <arquivos>
 */
const path = require('node:path');

function statusDoEvento(tipo, d) {
  if (d.todo !== undefined && d.todo !== false) return 'todo';
  if (d.skip !== undefined && d.skip !== false) return 'skip';
  return tipo === 'test:pass' ? 'pass' : 'fail';
}

module.exports = async function* reporterEsteira(source) {
  const raiz = process.cwd();
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.details && d.details.type === 'suite') continue;
    const linha = {
      arquivo: d.file ? path.relative(raiz, d.file) : 'não informado',
      nome: d.name,
      status: statusDoEvento(ev.type, d),
      ms: d.details && typeof d.details.duration_ms === 'number' ? Math.round(d.details.duration_ms) : null,
    };
    if (linha.status !== 'pass') {
      const motivo = typeof d.todo === 'string' ? d.todo : typeof d.skip === 'string' ? d.skip : (d.details && d.details.error && d.details.error.message) || '';
      linha.motivo = String(motivo).slice(0, 300);
    }
    yield `${JSON.stringify(linha)}\n`;
  }
};

module.exports.statusDoEvento = statusDoEvento;
