'use strict';

const { mktError } = require('../marketing.errors');

/** Erros dos templates e da aprovação (M9-D404). Mensagens em português; o detalhe técnico fica em details. */
const templateNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Template não encontrado.');
const contentNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Conteúdo não encontrado.');
const templateImmutable = (details) => mktError(409, 'MKT_TEMPLATE_IMMUTABLE', 'Template publicado não pode ser editado; crie uma nova versão.', details);
const templateVersionOutdated = (details) =>
  mktError(409, 'MKT_TEMPLATE_VERSION_OUTDATED', 'Já existe uma versão mais nova deste template publicada; publique a versão mais nova.', details);
const unknownVariable = (names) => mktError(422, 'MKT_TEMPLATE_UNKNOWN_VARIABLE', 'O template usa uma variável que não existe.', { variables: names });
const officialRefRequired = (details) => mktError(422, 'MKT_TEMPLATE_OFFICIAL_REF_REQUIRED', 'Este canal exige template oficial aprovado.', details);
const brandTokensInvalid = (problems) => mktError(422, 'MKT_TEMPLATE_BRAND_TOKENS_INVALID', 'A identidade visual do template é inválida.', { problems });
const invalidInput = (message, details) => mktError(400, 'VALIDATION_ERROR', message, details);
const approvalInvalidated = (details) => mktError(409, 'MKT_APPROVAL_INVALIDATED', 'O conteúdo mudou desde a aprovação; aprove novamente.', details);

module.exports = {
  templateNotFound, contentNotFound, templateImmutable, templateVersionOutdated, unknownVariable, officialRefRequired,
  brandTokensInvalid, invalidInput, approvalInvalidated,
};
