'use strict';

const { govError } = require('../governance.errors');

/** Erros do registro de flags e configurações (M9-D870 §4): códigos GOV_FLAG_*, mensagens em português. */
const ownerRequired = () => govError(422, 'GOV_FLAG_OWNER_REQUIRED', 'Informe o responsável pela chave.');
const ownerInvalid = () => govError(422, 'GOV_FLAG_OWNER_INVALID', 'O responsável deve ser uma pessoa ativa desta empresa.');
const validityInvalid = () => govError(422, 'GOV_FLAG_VALIDITY_INVALID', 'O fim da validade deve ser após o início.');
const valueInvalid = (details) => govError(422, 'GOV_FLAG_VALUE_INVALID', 'O valor não corresponde ao tipo da chave.', details);
const duplicate = () => govError(409, 'GOV_FLAG_DUPLICATE', 'Já existe uma chave igual neste escopo.');
const versionConflict = (details) => govError(409, 'GOV_FLAG_VERSION_CONFLICT', 'A chave foi alterada por outra pessoa. Recarregue e tente de novo.', details);
const notFound = () => govError(404, 'GOV_FLAG_NOT_FOUND', 'Chave não encontrada.');
const inputInvalid = (message, details) => govError(422, 'GOV_FLAG_INPUT_INVALID', message, details);
const reasonRequired = () => govError(422, 'GOV_FLAG_REASON_REQUIRED', 'Informe o motivo da alteração.');
const platformOnly = () => govError(403, 'GOV_FLAG_PLATFORM_ONLY', 'Este parâmetro só é alterado pela equipe da plataforma.');
const expired = () => govError(422, 'GOV_FLAG_EXPIRED', 'A chave expirou: estenda a validade para uma data futura para reativá-la.');
const sourceLocked = () => govError(422, 'GOV_FLAG_SOURCE_LOCKED', 'Esta configuração vem das Configurações da empresa: só valor, responsável, risco e descrição podem mudar aqui.');
const expiryRequired = () => govError(422, 'GOV_FLAG_EXPIRY_REQUIRED', 'Flag temporária precisa de data de expiração.');
const keyProtected = (message) => govError(403, 'GOV_FLAG_KEY_PROTECTED', message || 'Esta chave só muda pelo fluxo do módulo responsável por ela.');

module.exports = { platformOnly, keyProtected, expiryRequired, ownerRequired, ownerInvalid, validityInvalid, valueInvalid, duplicate, versionConflict, notFound, inputInvalid, reasonRequired, expired, sourceLocked };
