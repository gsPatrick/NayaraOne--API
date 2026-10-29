'use strict';

/**
 * Aplica ao padrão do sistema (ai.agents, versão 1, DRAFT e desabilitado) o conteúdo de cada agente da NAY definido em código
 * (M9-D039 em diante): finalidade, política, escopos, limites e allowlist. Idempotente. Roda com a conexão do DONO do banco, informada
 * em DATABASE_ADMIN_URL; nunca lê o .env. Só aceita banco local, a não ser que AI_SEED_ALLOW_REMOTE=1 (decisão de quem opera).
 *
 *   DATABASE_ADMIN_URL=postgres://...@127.0.0.1:5432/banco node scripts/ai/seedSystemAgents.js
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { applySystemDefinition } = require('../../src/features/ai/agents/kit/systemSeed');
const { SYSTEM_AGENT_DEFINITIONS } = require('../../src/features/ai/agents/kit/definitions');

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('Informe DATABASE_ADMIN_URL (conexão do dono do banco).');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.AI_SEED_ALLOW_REMOTE !== '1') {
    throw new Error(`Banco em ${host}: recusado. Use um banco local ou AI_SEED_ALLOW_REMOTE=1 conscientemente.`);
  }
  const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false });
  try {
    await sequelize.transaction(async (transaction) => {
      const query = (sql, replacements) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
      for (const definition of SYSTEM_AGENT_DEFINITIONS) {
        const out = await applySystemDefinition(query, definition);
        console.log(`[seedSystemAgents] ${out.code}: ${out.tools} ferramentas, hash ${out.configHash.slice(0, 12)}…`);
      }
    });
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => { console.error(`[seedSystemAgents] ${err.message}`); process.exit(1); });
