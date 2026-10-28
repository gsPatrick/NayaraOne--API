'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros do calendário (M9-D801 §4). Códigos novos levam GOV_; VALIDATION_ERROR é da lista fechada da plataforma. */
const rangeInvalid = () => govError(400, 'GOV_CALENDAR_RANGE_INVALID', 'A data inicial deve ser anterior à final.');
const sourceInvalid = (details) => govError(400, 'GOV_CALENDAR_SOURCE_INVALID', 'Tipo de origem inválido.', details);
const commitmentInvalid = () => govError(400, 'GOV_COMMITMENT_INVALID', 'O fim do compromisso deve ser após o início.');
const commitmentOwnerOnly = () => govError(403, 'GOV_COMMITMENT_OWNER_ONLY', 'Somente a pessoa responsável pelo compromisso ou um administrador pode fazer esta alteração.');
const commitmentTransition = (from, to) => govError(409, 'GOV_COMMITMENT_TRANSITION_INVALID', 'Esta mudança de situação do compromisso não é permitida.', { from, to });
const validation = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);

module.exports = { rangeInvalid, sourceInvalid, commitmentInvalid, commitmentOwnerOnly, commitmentTransition, validation, notFound: govNotFound };
