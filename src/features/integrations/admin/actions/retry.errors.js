'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do retry humano (M9-D250). A mensagem de 409 e 410 é a do livro; o detalhe técnico fica em `details`. */
const notAllowed = (details) => AppError.conflict('Este erro não pode ser repetido.', 'INTEGRATION_RETRY_NOT_ALLOWED', details);
const payloadGone = () => new AppError('O conteúdo original não está mais disponível; peça o reenvio ao fornecedor.', 410, 'INTEGRATION_RETRY_PAYLOAD_GONE');
const errorNotFound = () => AppError.notFound('Erro de integração não encontrado.', 'INTEGRATION_ERROR_NOT_FOUND');
const confirmRequired = () => notAllowed({ requires: 'confirmDangerous', hint: 'Operação perigosa: confirme com "confirmDangerous": true depois de conferir no fornecedor.' });

module.exports = { notAllowed, payloadGone, errorNotFound, confirmRequired };
