'use strict';

// M9-D035 — leitura das áreas para os resolvedores RULE da Diretoria. Cada área é lida pela MESMA definição de tool que o modelo usaria, com a
// permissão do ator conferida antes: área sem permissão não é lida e vira "<Área>: sem acesso". O escopo de dados é o do próprio agente
// (somente `*.summary`), então as tools compartilhadas devolvem agregado. As leituras são sequenciais (uma conexão por transação).
const { readToolOutput, servicesFor } = require('../kit/readTool');
const { AREAS, DATA_SCOPES } = require('./diretoria.policy');

/** `[{ ...área, permission, denied, output|null }]` das áreas pedidas (padrão: todas). */
async function readAreas({ ruleInput, tenant, transaction, only }) {
  const services = servicesFor({ ruleInput, tenant, transaction, dataScopes: DATA_SCOPES });
  const out = [];
  for (const area of AREAS.filter((a) => !only || only.includes(a.topic))) {
    out.push({ ...area, ...(await readToolOutput({ toolName: area.tool, ruleInput, tenant, transaction, services })) });
  }
  return out;
}

module.exports = { readAreas };
