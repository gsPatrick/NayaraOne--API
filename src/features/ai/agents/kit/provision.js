'use strict';

const crypto = require('node:crypto');
const registry = require('../agentRegistry.service');
const { computeConfigHash } = require('../agentConfigHash');

/**
 * Cadastro do agente pela definição de código (M9-D039 em diante): cria a versão seguinte da empresa em DRAFT e desabilitada, com o
 * propósito, a política, os escopos, os limites e a allowlist da definição. Segue o ciclo normal (avaliação verde, homologação por
 * outra pessoa, ativação). A chave de idempotência deriva do conteúdo: repetir a mesma definição devolve a versão já criada
 * (`replay: true`); definição que mudou cria a versão seguinte.
 */
const payloadOf = (definition) => {
  const { code, ...fields } = definition;
  return { code, fields };
};

function definitionHash(definition) {
  const { code, fields } = payloadOf(definition);
  return computeConfigHash({ code, ...fields });
}

async function provisionAgentVersion(ctx, definition, transaction) {
  const { code, fields } = payloadOf(definition);
  const key = `provision:${code}:${crypto.createHash('sha256').update(definitionHash(definition)).digest('hex').slice(0, 24)}`;
  return registry.createVersion(ctx, code, { ...fields, tools: fields.tools.map((t) => ({ ...t })), idempotencyKey: key }, transaction);
}

module.exports = { provisionAgentVersion, definitionHash };
