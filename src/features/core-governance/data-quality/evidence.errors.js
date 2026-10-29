'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros da origem/evidência de campo crítico (M9-D807 §4). Códigos novos levam GOV_. */
const required = () => govError(422, 'GOV_EVIDENCE_REQUIRED', 'Informe a origem e o comprovante desta alteração.');
const fileRequired = () => govError(422, 'GOV_EVIDENCE_FILE_REQUIRED', 'Anexe o documento que comprova a alteração.');
const noteTooShort = (minimum) => govError(422, 'GOV_EVIDENCE_NOTE_TOO_SHORT', `Descreva a origem com pelo menos ${minimum} caracteres.`, { minimum });
const sourceInvalid = () => govError(422, 'GOV_EVIDENCE_SOURCE_INVALID', 'Origem inválida para esta operação.');
const fileNotFound = () => govNotFound('Arquivo não encontrado.');

module.exports = { required, fileRequired, noteTooShort, sourceInvalid, fileNotFound };
