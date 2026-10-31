'use strict';

const { govError, govNotFound } = require('../../governance.errors');
const exportErrors = require('../exports/export.errors');

/** Erros dos endereços assinados de uso único (download de anexo e impressão; M9-D920 §3.1 e §3.3). Vencido, de outra pessoa e assinatura inválida repetem os da exportação (M9-D822). */
const alreadyUsed = () => govError(410, 'GOV_DOWNLOAD_ALREADY_USED', 'Este endereço já foi usado. Faça um novo pedido.');
const notAvailable = () => govNotFound('Registro não encontrado.');
const batchInvalid = (max) => govError(400, 'GOV_DOWNLOAD_BATCH_INVALID', `Informe de 1 a ${max} arquivos, sem repetir.`, { max });

module.exports = { alreadyUsed, notAvailable, batchInvalid, expired: exportErrors.expired, notOwner: exportErrors.notOwner, linkInvalid: exportErrors.linkInvalid, failed: exportErrors.failed };
