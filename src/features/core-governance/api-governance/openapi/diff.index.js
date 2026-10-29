'use strict';

const { diffOperations } = require('./diff.operations');

/** Mudanças incompatíveis da candidata sobre a base, na MESMA major (lista fechada da M9-D840 §3.2). */
const diffContracts = (baseDoc, candDoc, options = {}) => diffOperations(baseDoc, candDoc, options);

module.exports = { diffContracts };
