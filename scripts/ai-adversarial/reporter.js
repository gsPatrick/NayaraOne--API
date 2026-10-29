'use strict';

/** Repórter do node:test (M9-D042): uma linha JSON por teste concluído (nome, resultado, duração, mensagem do erro). Lido por ai-adversarial-report.js. */
module.exports = async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    if (d.details && d.details.type === 'suite') continue;
    const erro = d.details && d.details.error;
    yield `${JSON.stringify({
      nome: d.name, passou: event.type === 'test:pass', pulado: Boolean(d.skip || d.todo), duracaoMs: Math.round((d.details && d.details.duration_ms) || 0),
      erro: erro ? String(erro.message || erro).split('\n')[0].slice(0, 300) : null,
    })}\n`;
  }
};
