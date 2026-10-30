'use strict';

/** Valores do RACI e fases do corte (M9-D902). */
const RACI = Object.freeze({ R: 'R', A: 'A', C: 'C', I: 'I' });
const PHASES = Object.freeze(['PRE', 'CUTOVER', 'POST']);

/** Atividade cujo RACI governa as decisões da Torre de controle (M9-D901 §3.1.1). */
const FINAL_RECONCILIATION = 'FINAL_RECONCILIATION';

module.exports = { RACI, PHASES, FINAL_RECONCILIATION };
