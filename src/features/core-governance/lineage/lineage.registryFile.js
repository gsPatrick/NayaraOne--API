'use strict';

const repository = require('./lineage.repository');
const format = require('./lineage.registryFormat');

/**
 * Arquivo do registro (M9-D810 §3.5): exporta do banco SÓ o que veio das sementes (o que é igual em todo grupo e vai para o repositório); nós e arestas que
 * uma empresa cadastrou pela API ficam no banco dela. O texto é determinístico: mesmas sementes, mesmo arquivo, qualquer que seja a ordem das demandas.
 */
async function buildRegistryFile(tenant, transaction) {
  const { nodes, edges } = await repository.loadAll(tenant.groupId, transaction, { onlySeed: true });
  return format.serializeRegistry({
    nodes,
    edges: edges.map((e) => ({ from: { nodeType: e.fromType, code: e.fromCode }, to: { nodeType: e.toType, code: e.toCode }, transformation: e.transformation })),
  });
}

module.exports = { buildRegistryFile, serializeRegistry: format.serializeRegistry, diffRegistryFiles: format.diffRegistryFiles, registryProblem: format.registryProblem };
