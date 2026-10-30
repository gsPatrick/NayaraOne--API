'use strict';

/** Caminhos determinísticos da IA (Marco 9, M9-D228): catálogo, cobertura, execução e rotas. */
const { ENTRIES, TOOLS, AGENTS, declaredFor, toolEntry } = require('./deterministic.catalog');
const { KINDS } = require('./deterministic.kinds');
const { functionsWithoutDeterministicPath, staleEntries, systemAgentCodes } = require('./deterministic.coverage');
const { runDeterministic, runAiFunction } = require('./deterministic.run');
const { registerDeterministicRoutes } = require('./deterministic.routes');
const { MODE_DEGRADED, resolveAiMode, withAiFallback } = require('./deterministic.mode');

module.exports = {
  ENTRIES, TOOLS, AGENTS, KINDS, declaredFor, toolEntry, functionsWithoutDeterministicPath, staleEntries, systemAgentCodes, runDeterministic, runAiFunction, registerDeterministicRoutes, MODE_DEGRADED, resolveAiMode, withAiFallback,
};
