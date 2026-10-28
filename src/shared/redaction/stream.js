'use strict';

const { redactDeep } = require('./deep');
const { redactText } = require('./text');

/**
 * Destino do logger (pino) que redige a linha FINAL (já com os serializers aplicados) antes de gravar.
 * `taps` recebem exatamente o que foi gravado: é o "logger em memória" do teste de canário.
 */
function createRedactingStream(target) {
  const taps = new Set();
  return {
    write(line) {
      let out;
      try {
        out = `${JSON.stringify(redactDeep(JSON.parse(line)))}\n`;
      } catch (_) {
        out = redactText(String(line));
      }
      for (const tap of taps) tap(out);
      target.write(out);
    },
    addTap(fn) { taps.add(fn); return () => taps.delete(fn); },
  };
}

module.exports = { createRedactingStream };
