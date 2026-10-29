'use strict';

/**
 * M9-D037/D038 — aplica o conteúdo de um agente à linha do padrão do sistema (versão 1, DRAFT, desabilitada, sem empresa) semeada vazia
 * pela M9-D004, e semeia os casos do golden dataset do sistema. Idempotente. As tabelas têm RLS FORCE: a migration (dona das tabelas)
 * desliga o FORCE só dentro da própria transação e o religa antes de terminar, para o UPDATE/INSERT do sistema valer em qualquer papel.
 */
const { canonicalHash } = require('./aiAgentsSeed');

async function comForcaDesligada(q, tabelas, fn) {
  for (const t of tabelas) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  try { await fn(); } finally { for (const t of tabelas) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); }
}

async function aplicarAgente(q, agente) {
  const [rows] = await q("SELECT id, status FROM ai.agents WHERE company_id IS NULL AND code = :code AND version = 1 FOR UPDATE", { code: agente.code });
  if (!rows.length) throw new Error(`O padrão do sistema de ${agente.code} não existe; a migration 701 precisa ter rodado.`);
  if (rows[0].status !== 'DRAFT') throw new Error(`O padrão do sistema de ${agente.code} já saiu de DRAFT e não muda.`);
  const hash = canonicalHash({ ...agente, tools: agente.tools });
  const id = rows[0].id;
  await q("DELETE FROM ai.agent_tools WHERE agent_id = :id", { id });
  await q(
    `UPDATE ai.agents SET purpose = :purpose, system_policy = :systemPolicy, model_policy = CAST(:modelPolicy AS jsonb), data_scopes = CAST(:dataScopes AS jsonb),
       limits = CAST(:limits AS jsonb), criticality = :criticality, config_hash = :hash WHERE id = :id`,
    { id, purpose: agente.purpose, systemPolicy: agente.systemPolicy, modelPolicy: JSON.stringify(agente.modelPolicy), dataScopes: JSON.stringify(agente.dataScopes), limits: JSON.stringify(agente.limits), criticality: agente.criticality, hash }
  );
  for (const t of agente.tools) {
    await q(
      `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval, enabled)
       VALUES (gen_random_uuid(), NULL, NULL, :id, :toolName, :permissionCode, :riskLevel, :requiresHumanApproval, :enabled)`,
      { id, ...t }
    );
  }
}

async function semearGolden(q, agentCode, casos) {
  for (const c of casos) {
    await q(
      `INSERT INTO ai.golden_cases (group_id, company_id, agent_code, case_key, category, input, fixtures, expected, must_not, version, status)
       SELECT NULL, NULL, :agentCode, :caseKey, :category, :input, CAST(:fixtures AS jsonb), CAST(:expected AS jsonb), CAST(:mustNot AS jsonb), 1, 'ACTIVE'
        WHERE NOT EXISTS (SELECT 1 FROM ai.golden_cases WHERE company_id IS NULL AND agent_code = :agentCode AND case_key = :caseKey AND version = 1)`,
      { agentCode, caseKey: c.caseKey, category: c.category, input: c.input, fixtures: JSON.stringify(c.fixtures), expected: JSON.stringify(c.expected), mustNot: JSON.stringify(c.mustNot) }
    );
  }
}

module.exports = { aplicarAgente, semearGolden, comForcaDesligada };
