'use strict';

const { registerAgentScope, getAgentScope, listAgentScopes } = require('./scope.registry');
const { scopeGuard, applyAgentOutputRules } = require('./scope.guard');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');

let wired = false;
/** Liga o guarda de fronteira ao roteador (uma vez por processo). */
function wireScopeGuard() {
  if (!wired) { ruleResolvers.registerGuard(scopeGuard); wired = true; }
}

module.exports = { registerAgentScope, getAgentScope, listAgentScopes, scopeGuard, applyAgentOutputRules, wireScopeGuard };
