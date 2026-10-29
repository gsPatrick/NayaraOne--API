'use strict';

// Os agentes da NAY definidos em código (src/features/ai/agents/nay_*), cadastrados na empresa de teste. Serve ao portão de golden da esteira
// de CI (M9-D044, estágios 8 e 9): cada pasta nay_* precisa dar um agente, e um agente novo entra no portão sozinho.
const fs = require('node:fs');
const path = require('node:path');
const agents = require('../../../src/features/ai/agents');
const { provisionAgentVersion } = require('../../../src/features/ai/agents/kit');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const PASTA = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai', 'agents');

/** Códigos de agente e como cadastrar: com DEFINITION de código (provisionAgentVersion) ou copiando o padrão do sistema da migration. */
function agentesDoCodigo() {
  return fs.readdirSync(PASTA).filter((d) => d.startsWith('nay_')).sort().map((pasta) => {
    const m = require(path.join(PASTA, pasta));
    return { pasta, code: m.AGENT_CODE || m.CODE, definition: m.DEFINITION || null };
  });
}

/** Cadastra a versão do agente na empresa (DRAFT) sem exigir avaliação verde prévia: a avaliação é justamente o que o portão mede. */
async function cadastrar(ctx, agente, transaction) {
  await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, transaction);
  if (agente.definition) return provisionAgentVersion(ctx, agente.definition, transaction);
  return agents.createVersion(ctx, agente.code, {}, transaction);
}

module.exports = { agentesDoCodigo, cadastrar };
