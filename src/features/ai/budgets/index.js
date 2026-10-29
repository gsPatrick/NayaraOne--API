'use strict';

const service = require('./budget.service');
const { rolloverCompany } = require('./budgets.rollover');
const { estimateCost } = require('./budgets.money');
const settings = require('./budgets.settings');

/** Orçamento de uso da NAY (M9-D014): reserva antes de gastar, alertas por limiar, política de degradação e virada de mês. */
module.exports = { ...service, rolloverCompany, estimateCost, ...settings };
