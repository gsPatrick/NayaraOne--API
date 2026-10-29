'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros da fila de merge e review (M9-D805 §4). Códigos novos levam GOV_. */
const itemFinal = () => govError(409, 'GOV_QUEUE_ITEM_FINAL', 'Este item já foi decidido.');
const notSteward = () => govError(403, 'GOV_NOT_DOMAIN_STEWARD', 'Você não é responsável por este domínio.');
const decisionInvalid = () => govError(400, 'GOV_QUEUE_DECISION_INVALID', 'Decisão inválida para este item.');
const survivorInvalid = () => govError(400, 'GOV_MERGE_SURVIVOR_INVALID', 'O registro mantido deve ser um dos dois do par.');
const conflictUnresolved = (fields) => govError(400, 'GOV_MERGE_FIELD_CHOICE_REQUIRED', 'Escolha o valor que fica em cada campo em conflito.', { fields });
const notFound = () => govNotFound('Registro não encontrado.');
const itemNotFound = () => govNotFound('Item da fila não encontrado.');

module.exports = { itemFinal, notSteward, decisionInvalid, survivorInvalid, conflictUnresolved, notFound, itemNotFound };
