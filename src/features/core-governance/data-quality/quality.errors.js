'use strict';

const { govError } = require('../governance.errors');

/** Erros da qualidade de cadastro (M9-D806 §4). Códigos novos levam GOV_. */
const filterInvalid = (details) => govError(400, 'GOV_DQ_FILTER_INVALID', 'Filtro de qualidade inválido.', details);

module.exports = { filterInvalid };
