'use strict';

const registry = require('./agentRegistry.service');
const lifecycle = require('./agentLifecycle.service');
const resolver = require('./agentResolver.service');
const { computeConfigHash } = require('./agentConfigHash');
const { resolveLimits } = require('./agentLimits');
const { AgentRunGuard } = require('./AgentRunGuard');

/** Agentes versionados da NAY (M9-D004): registro de versões, ciclo de vida, resolução da versão ativa, allowlist e limites do run. */
module.exports = {
  ...registry,
  ...lifecycle,
  ...resolver,
  computeConfigHash,
  resolveLimits,
  AgentRunGuard,
};

require('./builtin'); // registra a fronteira, os resolvedores e os números dos agentes do livro (M9-D037 em diante)
