'use strict';

/**
 * Quarentena dos uploads externos (Marco 9, M9-D247): todo arquivo que chega de fora (mídia de mensagem, anexo, foto baixada de URL, documento de portal) entra em files.quarantine, passa pelo
 * antivírus e pelas verificações de conteúdo e só então é promovido ao módulo de arquivos. Ao carregar, liga o destino real da quarentena do guarda SSRF e o passo da rodada do worker
 * (verificação dos pendentes e descarte dos vencidos). Fachada da API pública.
 */
const { registerDispatchCycleStep } = require('../../integrations/dispatch/worker/worker.hooks');
const { receiveExternalUpload } = require('./quarantine.receive');
const { verifyQuarantine } = require('./quarantine.verify');
const { assertReleased } = require('./quarantine.access');
const { expireQuarantine, runQuarantineCycle } = require('./quarantine.cycle');
const { installQuarantineSink, quarantineSink } = require('./quarantine.sink');
const { readQuarantineParams, PADROES } = require('./quarantine.params');
const { QUARANTINE_SETTINGS_SCHEMA } = require('./quarantine.settings');
const { detectType } = require('./quarantine.magic');
const { STATUS } = require('./quarantine.constants');

let installed = false;
function installQuarantine() {
  if (installed) return;
  installed = true;
  installQuarantineSink();
  registerDispatchCycleStep((ctx, meta, transaction) => runQuarantineCycle(ctx, meta, transaction));
}

installQuarantine();

module.exports = {
  installQuarantine, receiveExternalUpload, verifyQuarantine, assertReleased, expireQuarantine, runQuarantineCycle, quarantineSink, readQuarantineParams, QUARANTINE_PADROES: PADROES, QUARANTINE_SETTINGS_SCHEMA, detectType, QUARANTINE_STATUS: STATUS,
};
