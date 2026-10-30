'use strict';

const { mktError } = require('../../marketing.errors');

const reviewBlockedOpenCase = (details) => mktError(409, 'MKT_REVIEW_BLOCKED_OPEN_CASE', 'Há ocorrência aberta: o pedido de avaliação foi bloqueado.', details);
const reviewNotRequested = (details) => mktError(409, 'MKT_REVIEW_NOT_REQUESTED', 'Este pedido de avaliação não foi enviado: não há retorno da plataforma a registrar.', details);
const reviewRatingInvalid = (details) => mktError(422, 'MKT_REVIEW_RATING_INVALID', 'A nota pública deve ser um número inteiro de 1 a 5.', details);
const reviewNotFound = () => mktError(404, 'MKT_REVIEW_NOT_FOUND', 'Pedido de avaliação não encontrado.');
const paramInvalid = (details) => mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', details);

module.exports = { reviewBlockedOpenCase, reviewNotRequested, reviewRatingInvalid, reviewNotFound, paramInvalid };
