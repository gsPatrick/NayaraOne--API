'use strict';

const { exigir } = require('./source');

const NOME = 'guard_replay_is_safe';
// O replay é seguro porque cada fluxo grava com uma chave única; a prova de comportamento (3 execuções = 1 efeito) está no teste. Aqui ficam as âncoras no código: se alguém tirar a chave, a guarda reprova.
const ANCORAS = [
  ['automations/runner/runner.service.js', /runIdempotencyKey\(/, 'a run do runner deve ter a chave sha256(versão:evento:sujeito); sem ela o replay dispara duas vezes'],
  ['automations/runner/runner.plan.js', /actionKey\(runKey,/, 'cada ação do runner deve ter action_key derivada da chave da run; sem ela a mensagem repete'],
  ['publications/schedule/schedule.jobs.js', /idempotency_key\s*=\s*:key/, 'o agendamento deve reaproveitar o job da mesma chave de idempotência; sem isso o post duplica'],
  ['publications/worker/worker.call.js', /idempotencyKey:\s*job\.idempotency_key/, 'o envio do job deve levar a chave de idempotência do job ao canal'],
  ['publications/messaging/message/message.send.js', /findByActionKey\(/, 'o envio de mensagem deve procurar a action_key antes de enviar; sem isso a mensagem repete'],
  ['automations/reviews/review.repository.js', /findByKey|idempotency_key/, 'o pedido de avaliação deve ter chave de idempotência'],
];

/** Reexecutar qualquer fluxo não duplica mensagem nem post. */
function verificar(raiz) {
  return ANCORAS.flatMap(([arquivo, padrao, regra]) => exigir(raiz, arquivo, padrao, regra));
}

module.exports = { NOME, verificar };
