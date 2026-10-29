'use strict';

const { computeConfigHash } = require('../agentConfigHash');
const { validateAgentFields, validateTools } = require('../agents.validation');

/**
 * Aplica a definição de código à linha PADRÃO DO SISTEMA do agente (versão 1, DRAFT, desabilitada, sem empresa), semeada vazia pela
 * M9-D004. Roda com a conexão do dono do banco (scripts/ai/seedSystemAgents.js), nunca pela API: nenhuma empresa grava no padrão do
 * sistema. Idempotente (o mesmo conteúdo dá o mesmo hash); recusa a linha que já saiu de DRAFT, pois ela é imutável.
 * `query(sql, replacements)` devolve as linhas do SELECT.
 */
async function applySystemDefinition(query, definition) {
  const { code, tools: rawTools, ...rest } = definition;
  const fields = validateAgentFields(rest);
  const tools = validateTools(rawTools);
  const rows = await query("SELECT id, status FROM ai.agents WHERE company_id IS NULL AND code = :code AND version = 1 FOR UPDATE", { code });
  if (!rows.length) throw new Error(`O padrão do sistema de ${code} não existe; rode as migrations.`);
  if (rows[0].status !== 'DRAFT') throw new Error(`O padrão do sistema de ${code} já saiu de DRAFT e não muda.`);
  const configHash = computeConfigHash({ code, ...fields, tools });
  await query(
    `UPDATE ai.agents SET purpose = :purpose, system_policy = :systemPolicy, model_policy = CAST(:modelPolicy AS jsonb), data_scopes = CAST(:dataScopes AS jsonb),
       limits = CAST(:limits AS jsonb), criticality = :criticality, config_hash = :configHash WHERE id = :id RETURNING id`,
    {
      id: rows[0].id, purpose: fields.purpose, systemPolicy: fields.systemPolicy, modelPolicy: JSON.stringify(fields.modelPolicy), dataScopes: JSON.stringify(fields.dataScopes),
      limits: JSON.stringify(fields.limits), criticality: fields.criticality, configHash,
    }
  );
  await query('DELETE FROM ai.agent_tools WHERE agent_id = :id RETURNING id', { id: rows[0].id });
  for (const t of tools) {
    await query(
      `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval, enabled)
       VALUES (gen_random_uuid(), NULL, NULL, :id, :toolName, :permissionCode, :riskLevel, :requiresHumanApproval, :enabled) RETURNING id`,
      { id: rows[0].id, ...t }
    );
  }
  return { code, configHash, tools: tools.length };
}

module.exports = { applySystemDefinition };
