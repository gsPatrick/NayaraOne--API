'use strict';

/** Recuperador de envios presos em SENDING (M9-D205, regra da M9-D215 3.4): a implementação mora em reconcile/orphan.js. */
const { recoverStaleSending } = require('./reconcile/orphan');

module.exports = { recoverStaleSending };
