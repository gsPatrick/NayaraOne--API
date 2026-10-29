'use strict';

const AppError = require('../../../utils/AppError');

/** Entrada de cache de outra empresa (ou inexistente) é 404, sem revelar a existência (M9-D015). */
const notFound = () => new AppError('Resultado não encontrado.', 404, 'AI_CACHE_NOT_FOUND');

module.exports = { notFound };
