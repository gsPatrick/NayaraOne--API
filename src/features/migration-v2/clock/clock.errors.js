'use strict';

const { govError } = require('../../core-governance/governance.errors');

/** Erros da validação de relógio (M9-D908 §4). */
module.exports = {
  drift: (details) => govError(409, 'GOV_MIG_CLOCK_DRIFT', 'Os relógios dos sistemas diferem além do permitido.', details),
  unmeasured: (details) => govError(409, 'GOV_MIG_CLOCK_UNMEASURED', 'Não foi possível medir o relógio de todos os sistemas; o lote não parte sem a medição.', details),
};
