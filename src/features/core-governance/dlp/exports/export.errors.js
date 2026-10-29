'use strict';

const { govError, govNotFound } = require('../../governance.errors');

/** Erros da exportação (M9-D822 §4). Mensagens em português, as do livro/da demanda. */
const resourceInvalid = () => govError(400, 'GOV_EXPORT_RESOURCE_INVALID', 'Tipo de exportação inválido.');
const columnInvalid = (details) => govError(400, 'GOV_EXPORT_COLUMN_INVALID', 'Coluna inválida para esta exportação.', details);
const formatInvalid = (details) => govError(400, 'GOV_EXPORT_FORMAT_INVALID', 'Formato inválido.', details);
const filterInvalid = (details) => govError(400, 'GOV_EXPORT_FILTER_INVALID', 'Filtro inválido para esta exportação.', details);
const bodyInvalid = (message, details) => govError(400, 'GOV_EXPORT_REQUEST_INVALID', message, details);
const notOwner = () => govError(403, 'GOV_EXPORT_NOT_OWNER', 'Este arquivo foi gerado para outra pessoa.');
const expired = () => govError(410, 'GOV_EXPORT_EXPIRED', 'O arquivo expirou. Faça uma nova solicitação.');
const notReady = () => govError(409, 'GOV_EXPORT_NOT_READY', 'O arquivo ainda está sendo gerado.');
const failed = (code) => govError(409, 'GOV_EXPORT_FAILED', 'A geração do arquivo falhou. Faça uma nova solicitação.', { errorCode: code || null });
const linkInvalid = () => govError(403, 'GOV_EXPORT_LINK_INVALID', 'Endereço de download inválido ou vencido.');
const moved = () => govError(410, 'GOV_EXPORT_MOVED', 'Esta exportação agora é pedida por POST /exports, com finalidade e justificativa.');
const notFound = () => govNotFound('Registro não encontrado.');

module.exports = { resourceInvalid, columnInvalid, formatInvalid, filterInvalid, bodyInvalid, notOwner, expired, notReady, failed, linkInvalid, moved, notFound };
