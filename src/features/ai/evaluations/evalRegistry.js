'use strict';

const { getToolRegistry, buildDefaultRegistry } = require('../tools');

/** Registro de tools da avaliação: o do processo, ou o padrão quando o do processo ainda não subiu. */
async function evalToolRegistry() {
  try { return getToolRegistry(); } catch (e) { return buildDefaultRegistry(); }
}

module.exports = { evalToolRegistry };
