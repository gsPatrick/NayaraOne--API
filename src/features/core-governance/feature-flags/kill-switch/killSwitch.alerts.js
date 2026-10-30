'use strict';

const { dateKeyInZone } = require('../../calendar/sources/time');
const { sendCriticalAlert } = require('../flags.alerts');
const { ALERT_TYPES, STALE_REASONS } = require('./killSwitch.constants');

const pad = (n) => String(n).padStart(2, '0');
const WHY = {
  [STALE_REASONS.never]: 'nunca foi testado com sucesso',
  [STALE_REASONS.old]: 'o último teste com sucesso é mais antigo que a periodicidade',
  [STALE_REASONS.version]: 'o probe mudou de versão e ainda não houve teste com sucesso nela',
  [STALE_REASONS.probeMissing]: 'o probe cadastrado não existe no código',
};

/** Alerta CRÍTICO de teste que falhou (ou foi interrompido): um por switch e dia. Devolve quantas pessoas foram avisadas. */
function alertFailed(tenant, row, { environment, probe, why, params, now }, transaction) {
  return sendCriticalAlert(tenant, {
    alertKey: `kill_switch.failed:${row.id}:${dateKeyInZone(now)}`, type: ALERT_TYPES.failed, entry: row,
    title: `kill switch ${row.key} não foi comprovado no teste`,
    body: `O teste automático do kill switch ${row.key} (probe ${probe.name}, versão ${probe.version}, ambiente ${environment}) não foi comprovado: ${why}. O switch ficou marcado como NÃO VERIFICADO e o teste se repete todo dia às ${pad(params.killHour)}:${pad(params.killMinute)} (Brasília) até passar. O estado anterior do switch foi restaurado.`,
  }, transaction);
}

/** Alerta CRÍTICO de switch sem teste PASS dentro da periodicidade: um por switch e dia. */
function alertStale(tenant, row, status, { now }, transaction) {
  return sendCriticalAlert(tenant, {
    alertKey: `kill_switch.stale:${row.id}:${dateKeyInZone(now)}`, type: ALERT_TYPES.stale, entry: row,
    title: `kill switch ${row.key} sem teste válido há mais de ${status.days} dias`,
    body: `O kill switch ${row.key} está sem teste PASS dentro da periodicidade de ${status.days} dias (governanca.flags.kill_teste_dias): ${WHY[status.reason] || status.reason}. Um botão de emergência nunca testado pode não funcionar na hora de usar.`,
  }, transaction);
}

module.exports = { alertFailed, alertStale };
