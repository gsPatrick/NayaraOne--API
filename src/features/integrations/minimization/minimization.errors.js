'use strict';

const AppError = require('../../../utils/AppError');

/** 422: um campo OBRIGATÓRIO do port está acima da classificação permitida para a finalidade; nada é enviado. */
const classificationViolation = (fieldName) => AppError.unprocessable(
  'O envio incluiria dado não permitido para esta finalidade.', 'INTEGRATION_PAYLOAD_CLASSIFICATION_VIOLATION', { field: fieldName }
);

/** 422: campo obrigatório do port ausente no objeto de domínio. */
const requiredMissing = (fieldName) => AppError.unprocessable(
  'O envio não tem um dado obrigatório para esta operação.', 'INTEGRATION_PAYLOAD_REQUIRED_MISSING', { field: fieldName }
);

/** 500: entidade/DTO interno entregue ao mapper no lugar de um objeto de domínio simples. */
const entityNotAllowed = () => AppError.internal(
  'O mapper recebeu uma entidade interna; entregue um objeto simples com os campos do domínio.', 'INTEGRATION_PAYLOAD_ENTITY_NOT_ALLOWED'
);

/** 500: operação sem outputMapper (todo adapter precisa declarar o mapper da operação). */
const mapperMissing = (domain, operation) => AppError.internal(
  `A operação ${operation} do port ${domain} não declara outputMapper.`, 'INTEGRATION_MAPPER_MISSING'
);

module.exports = { classificationViolation, requiredMissing, entityNotAllowed, mapperMissing };
