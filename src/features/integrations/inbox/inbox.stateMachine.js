'use strict';

const { TRANSITIONS } = require('./inbox.constants');
const { invalidTransition } = require('./inbox.errors');

/** Recusa (500 interno) a transição fora da tabela. */
function assertTransition(from, to) {
  if (!(TRANSITIONS[from] || []).includes(to)) throw invalidTransition(from, to);
}

module.exports = { assertTransition };
