'use strict';

const { mktError } = require('./marketing.errors');

/** Erros do kill switch do Marketing (M9-D425): prefixo MKT_ e mensagem em português, sem stack nem detalhe interno. */
const inputInvalid = (details) => mktError(400, 'MKT_KILL_SWITCH_INPUT_INVALID', 'Informe o escopo (GLOBAL, CHANNEL, CAMPAIGN ou AUTOMATION), o alvo quando houver e active verdadeiro ou falso.', details);
const reasonRequired = (min) => mktError(400, 'MKT_REASON_REQUIRED', `Informe o motivo (mínimo ${min} caracteres).`, { minChars: min });
const compromisedScope = () => mktError(422, 'MKT_KILL_SWITCH_COMPROMISED_SCOPE', 'A conta comprometida só pode ser marcada em escopo de canal.');
const targetNotFound = (details) => mktError(404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND', 'Campanha, canal ou automação não encontrado.', details);
const incidentOpen = (details) => mktError(409, 'MKT_KILL_SWITCH_INCIDENT_OPEN', 'Este bloqueio veio de um incidente crítico: só pode ser desfeito depois que o incidente for resolvido.', details);
const outboundBlocked = (details) => mktError(423, 'MKT_KILL_SWITCH_ACTIVE', 'O kill switch do Marketing está ativo: nenhuma ação de saída é executada até a reativação.', details);
const incidentInvalid = (details) => mktError(422, 'MKT_KILL_SWITCH_INCIDENT_INVALID', 'Informe o identificador do incidente crítico e o responsável pela ação.', details);

module.exports = { inputInvalid, reasonRequired, compromisedScope, targetNotFound, incidentOpen, outboundBlocked, incidentInvalid };
