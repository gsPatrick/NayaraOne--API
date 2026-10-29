'use strict';

const { provisionAgentVersion, definitionHash } = require('./provision');
const { installGoldenCases } = require('./golden');
const { applySystemDefinition } = require('./systemSeed');
const { SYSTEM_AGENT_DEFINITIONS } = require('./definitions');

/** Ferramentas de cadastro dos agentes da NAY a partir da definição de código: versão da empresa, golden e padrão do sistema. */
module.exports = { provisionAgentVersion, definitionHash, installGoldenCases, applySystemDefinition, SYSTEM_AGENT_DEFINITIONS };
