'use strict';

/**
 * Registro de conexões externas da execução offline (M9-D258, M9-D256 3.3 d). Carregado com `--require` pelos testes das etapas da esteira das integrações: toda conexão de socket
 * para endereço que não seja o próprio computador (loopback ou socket de arquivo) grava UMA linha com o host em INT_OFFLINE_LOG; nada é bloqueado e nenhum payload é registrado.
 * scripts/int-ci/offlineRelatorio.js conta as linhas e grava `chamadasExternas` em reports/offline-run.json. Sem INT_OFFLINE_LOG o arquivo não faz nada.
 */
const fs = require('node:fs');
const net = require('node:net');

const LOG = process.env.INT_OFFLINE_LOG;
const LOOPBACK = /^(?:localhost|0\.0\.0\.0|::1?|::ffff:127\.[\d.]+|127\.[\d.]+)$/i;

/** Destino do connect: null para socket de arquivo (path), { host } caso contrário. */
function destino(args) {
  // net.connect já normaliza os argumentos: o primeiro vira o vetor [opções, callback].
  if (Array.isArray(args[0])) return destino([args[0][0]]);
  const a = args[0];
  if (a && typeof a === 'object') return a.path ? null : { host: String(a.host || 'localhost') };
  if (typeof a === 'string' && Number.isNaN(Number(a))) return null;
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}

if (LOG) {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connectRegistrado(...args) {
    try {
      const d = destino(args);
      if (d && !LOOPBACK.test(d.host)) fs.appendFileSync(LOG, `${d.host}\n`);
    } catch (e) { /* o registro nunca derruba o teste */ }
    return original.apply(this, args);
  };
}

module.exports = { destino, LOOPBACK };
