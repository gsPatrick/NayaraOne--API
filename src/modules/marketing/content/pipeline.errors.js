'use strict';

const { mktError } = require('../marketing.errors');

/** Erros do pipeline de conteúdo (M9-D406). Mensagens em português; o detalhe técnico fica em details. */
const nayUnavailable = (details) =>
  mktError(503, 'MKT_NAY_UNAVAILABLE', 'A NAY está indisponível; escreva o conteúdo manualmente ou tente de novo.', details);
const scheduleTooSoon = (details) => mktError(422, 'MKT_SCHEDULE_TOO_SOON', 'O agendamento exige antecedência mínima configurada.', details);
const stepRequired = (details) => mktError(409, 'MKT_PIPELINE_STEP_REQUIRED', 'Conclua a validação anterior antes de continuar.', details);
const contentNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Conteúdo não encontrado.');
const contentInvalid = (message, details) => mktError(400, 'MKT_VALIDATION', message, details);
const separationOfDuties = () => mktError(403, 'MKT_FORBIDDEN', 'Quem gerou o conteúdo não pode aprová-lo.', { reason: 'SEPARATION_OF_DUTIES' });
const variableMissing = (names) => mktError(422, 'MKT_TEMPLATE_UNKNOWN_VARIABLE', 'O template usa uma variável sem valor.', { variables: names });

module.exports = { nayUnavailable, scheduleTooSoon, stepRequired, contentNotFound, contentInvalid, separationOfDuties, variableMissing };
