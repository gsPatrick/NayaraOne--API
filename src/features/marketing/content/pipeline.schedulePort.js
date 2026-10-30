'use strict';

/**
 * M9-D410 — Porta do agendamento. O passo `schedule` do pipeline (M9-D406) cria os jobs de publicação, que moram na área de publicações; as áreas só se
 * tocam pelo index e não podem formar ciclo, então a área de publicações REGISTRA aqui a sua função (como a NAY, o validador factual e a regra de aprovação).
 * Contrato: scheduleJobs({ tenant, actor, item, version, prepared }, transaction) -> [{ id, channel, status, replay }].
 */
let port = null;

function registerSchedulePort(impl) {
  if (!impl || typeof impl.scheduleJobs !== 'function') throw new TypeError('A porta de agendamento deve expor scheduleJobs.');
  port = impl;
}

function getSchedulePort() {
  if (!port) throw new Error('Porta de agendamento não registrada: carregue a área de publicações do Marketing.');
  return port;
}

module.exports = { registerSchedulePort, getSchedulePort };
