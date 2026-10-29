'use strict';

const { govError } = require('../../governance.errors');

/** Erros do catálogo de consumidores e da deprecação (M9-D841 §4). Os quatro primeiros têm código, status e texto fixados pelo livro. */
const ownerRequired = () => govError(422, 'GOV_API_OWNER_REQUIRED', 'Informe o responsável pela deprecação.');
const deprecationInvalid = () => govError(422, 'GOV_API_DEPRECATION_INVALID', 'A data de desligamento deve ser posterior ao anúncio.');
const versionSunset = () => govError(410, 'GOV_API_VERSION_SUNSET', 'Esta versão da API foi desativada.');
const sunsetRequired = () => govError(422, 'GOV_API_SUNSET_REQUIRED', 'Informe a data de desligamento.');
const dateInvalid = (field) => govError(422, 'GOV_API_DATE_INVALID', 'Informe uma data válida (AAAA-MM-DD ou data e hora ISO).', { field });
const ownerInvalid = () => govError(422, 'GOV_API_OWNER_INVALID', 'O responsável deve ser um usuário ativo da empresa.');
const targetInvalid = () => govError(422, 'GOV_API_TARGET_INVALID', 'Informe o alvo como "ROUTE:MÉTODO /caminho" ou "MAJOR:n".');
const replacementInvalid = () => govError(422, 'GOV_API_REPLACEMENT_INVALID', 'A substituta deve ser uma URL relativa iniciada por "/" com até 300 caracteres.');
const deprecationExists = () => govError(409, 'GOV_API_DEPRECATION_EXISTS', 'Já existe uma deprecação em andamento para este alvo.');
const deprecationFinal = () => govError(409, 'GOV_API_DEPRECATION_FINAL', 'Só uma deprecação anunciada pode ser cancelada.');
const consumerInvalid = (details) => govError(422, 'GOV_API_CONSUMER_INVALID', 'Dados do consumidor inválidos.', details);
const consumerExists = () => govError(409, 'GOV_API_CONSUMER_EXISTS', 'Já existe um consumidor com este nome ou esta credencial.');
const filterInvalid = (field, allowed) => govError(400, 'VALIDATION_ERROR', `Filtro "${field}" inválido.`, { field, allowed });

module.exports = {
  ownerRequired, deprecationInvalid, versionSunset, sunsetRequired, dateInvalid, ownerInvalid, targetInvalid, replacementInvalid, deprecationExists, deprecationFinal, consumerInvalid, consumerExists, filterInvalid,
};
