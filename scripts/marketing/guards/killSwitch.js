'use strict';

const { exigir } = require('./source');

const NOME = 'guard_kill_switch_always_checked';
const LEITURA = /\b(?:isOutboundBlocked|assertOutboundAllowed)\(/;
// Cada porta de saída do Marketing e o motivo; o "assertNotKilled" do livro é o par assertOutboundAllowed / isOutboundBlocked do killswitch.state.js.
const PORTAS = [
  ['automations/runner/runner.decide.js', 'o runner de automações deve consultar o kill switch antes de decidir o envio'],
  ['automations/runner/runner.due.js', 'a retomada das ações adiadas do runner deve consultar o kill switch'],
  ['publications/worker/worker.claim.js', 'o worker de publicação deve consultar o kill switch antes de reservar o job'],
  ['campaigns/stepDispatcher.js', 'o disparador de campanha deve consultar o kill switch antes de cada step'],
  ['publications/adapters/sendToChannel.js', 'a porta de saída de canal deve consultar o kill switch antes de resolver o adapter'],
  ['publications/messaging/message/message.send.js', 'o envio de mensagem deve consultar o kill switch antes do canSend'],
  ['publications/schedule/schedule.preconditions.js', 'o agendamento deve consultar o kill switch'],
];

/** Runner, worker e disparador de campanha chamam a leitura do kill switch. */
function verificar(raiz) {
  return PORTAS.flatMap(([arquivo, regra]) => exigir(raiz, arquivo, LEITURA, regra));
}

module.exports = { NOME, verificar };
