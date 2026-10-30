'use strict';

const { mktError } = require('../../marketing.errors');

/** Erros do agendamento e dos jobs de publicação (M9-D410). Prefixo MKT_, mensagem em português; o detalhe técnico vai em details. */
const channelConnectionInactive = (details) => mktError(409, 'MKT_CHANNEL_CONNECTION_INACTIVE', 'A conexão do canal está inativa.', details);
const jobNotCancellable = (details) => mktError(409, 'MKT_JOB_NOT_CANCELLABLE', 'Este job não pode ser cancelado.', details);
const jobAlreadyActive = (details) => mktError(409, 'MKT_JOB_ALREADY_ACTIVE', 'Já existe uma publicação ativa desta versão neste canal.', details);
const publicFieldsNotSanitized = (details) => mktError(409, 'MKT_PUBLIC_FIELDS_NOT_SANITIZED', 'O conteúdo ainda não passou pela limpeza dos campos públicos.', details);
const jobNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Publicação não encontrada.');
const filterInvalid = (message, details) => mktError(400, 'MKT_VALIDATION', message, details);

module.exports = { channelConnectionInactive, jobNotCancellable, jobAlreadyActive, publicFieldsNotSanitized, jobNotFound, filterInvalid };
