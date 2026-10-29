'use strict';

// Ambiente HTTP das rotas de execução da NAY (M9-D030/D034): sobe o app real no cluster descartável, concede permissões aos perfis do
// seed de dois tenants, cria agente ATIVO por SQL (superusuário do cluster descartável), orçamento pela rota e oportunidade commitada.
// Nunca chama MFA nem forja token.

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { admin, grant, startHttpEnv } = require('./aiHttpEnv');
const { usuario } = require('./iaRotasEnv');
const { criarOportunidadeCommitada } = require('./aiToolsEnv');

const LEITURA_CRM = ['crm:opportunities:read', 'people:read', 'radar:read'];
const PERFIS = ['CI GESTOR', 'CI CHECKER', 'CI MAKER', 'CI LEITURA'];
const POLITICA = { capability: 'chat', maxOutputTokens: 800, cacheableTaskTypes: [] };

/** Perfis: gestor (tudo da NAY + CRM), checker (corretor: ai:use e ai:read + CRM, sem ai:approve), maker (ai:use, ai:read e ai:evaluate, sem CRM), leitura (só ai:use). */
async function subir(porta) {
  await admin(
    `DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = ANY($1::text[]) AND (p.code LIKE 'ai:%' OR p.code = ANY($2::text[]))`,
    [PERFIS, [...LEITURA_CRM, 'crm:tasks:create', 'legal:read']]
  );
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'ai:audit', 'ai:budget', 'ai:evaluate', 'settings:read', 'settings:update', 'crm:tasks:create', ...LEITURA_CRM]);
  await grant('CI CHECKER', ['ai:use', 'ai:read', 'legal:read', ...LEITURA_CRM]);
  await grant('CI MAKER', ['ai:use', 'ai:read', 'ai:evaluate']);
  await grant('CI LEITURA', ['ai:use']);
  const env = await startHttpEnv(porta, [['A', 'gestor'], ['A', 'checker'], ['A', 'maker'], ['A', 'leitura'], ['B', 'gestor']]);
  const gestor = await usuario('A', 'gestor');
  const gestorB = await usuario('B', 'gestor');
  const pessoas = { gestor: gestor.id, checker: (await usuario('A', 'checker')).id, maker: (await usuario('A', 'maker')).id };
  const tenant = { groupId: gestor.groupId, companyId: gestor.companyId, userId: gestor.id };
  const tenantB = { groupId: gestorB.groupId, companyId: gestorB.companyId, userId: gestorB.id };
  for (const t of ['A:gestor', 'B:gestor']) assert.equal((await env.call('PUT', '/settings/ia.habilitada', env.tokens[t], { value: true })).status, 200);
  return { env, pessoas, tenant, tenantB };
}

async function encerrar(env, extras = []) {
  if (!env) return;
  for (const chave of extras) await env.call('PUT', `/settings/${chave}`, env.tokens['A:gestor'], { value: false });
  for (const t of ['A:gestor', 'B:gestor']) await env.call('PUT', '/settings/ia.habilitada', env.tokens[t], { value: false });
  setTimeout(() => process.exit(0), 300);
}

const codigoNovo = (prefixo = 'T') => `${prefixo}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

/** Linha da allowlist a partir do registro de tools (permissão, risco e aprovação como no boot). */
const LINHAS_TOOL = {
  'crm.getOpportunity': { permissionCode: 'crm:opportunities:read', riskLevel: 'LOW', requiresHumanApproval: false },
  'crm.getCustomerSummary': { permissionCode: 'people:read', riskLevel: 'LOW', requiresHumanApproval: false },
  'radar.listMatchesForOpportunity': { permissionCode: 'radar:read', riskLevel: 'LOW', requiresHumanApproval: false },
  'crm.createFollowUpTask': { permissionCode: 'crm:tasks:create', riskLevel: 'HIGH', requiresHumanApproval: true },
};

/** Versão ATIVA da empresa criada por SQL (DRAFT, allowlist, HOMOLOGATED, ACTIVE), com o orçamento mensal pela rota. */
async function agenteAtivo(env, tenant, { code = codigoNovo(), tools = ['crm.getOpportunity'], dataScopes = [], limits = { max_runs_por_minuto_usuario: 200 }, systemPolicy = 'Cite as fontes.', limit = '500.00', orcamento = true } = {}) {
  const id = crypto.randomUUID();
  // Num cluster compartilhado por vários arquivos, o código pode já ter versão da empresa: aposenta as vivas e segue a numeração.
  await admin("UPDATE ai.agents SET status = 'RETIRED', retired_at = now() WHERE company_id = $1 AND code = $2 AND status IN ('ACTIVE', 'HOMOLOGATED')", [tenant.companyId, code]);
  const versao = Number((await admin('SELECT coalesce(max(version), 0) + 1 AS v FROM ai.agents WHERE company_id = $1 AND code = $2', [tenant.companyId, code])).rows[0].v);
  await admin(
    `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, system_policy, model_policy, data_scopes, limits, criticality, enabled, config_hash)
     VALUES ($1, $2, $3, $4, $10, 'DRAFT', 'Agente de teste da M9-D030.', $5, $6::jsonb, $9::jsonb, $7::jsonb, 'NON_CRITICAL', false, $8)`,
    [id, tenant.groupId, tenant.companyId, code, systemPolicy, JSON.stringify(POLITICA), JSON.stringify(limits), crypto.randomBytes(32).toString('hex'), JSON.stringify(dataScopes), versao]
  );
  for (const nome of tools) {
    const l = LINHAS_TOOL[nome];
    await admin(
      `INSERT INTO ai.agent_tools (group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [tenant.groupId, tenant.companyId, id, nome, l.permissionCode, l.riskLevel, l.requiresHumanApproval]
    );
  }
  await admin("UPDATE ai.agents SET status = 'HOMOLOGATED', homologated_by = $2, homologated_at = now() WHERE id = $1", [id, tenant.userId]);
  await admin("UPDATE ai.agents SET status = 'ACTIVE', enabled = true, activated_by = $2, activated_at = now() WHERE id = $1", [id, tenant.userId]);
  if (orcamento) {
    const r = await env.call('POST', '/ai/budgets', env.tokens['A:gestor'], { agentCode: code, limitAmount: limit });
    // Outro arquivo do mesmo cluster pode já ter aberto o orçamento deste agente no mês: ele serve.
    assert.ok(r.status === 201 || (r.status === 409 && r.body.error.code === 'AI_BUDGET_EXISTS'), JSON.stringify(r.body));
  }
  return code;
}

/** Corpo mínimo de um pedido que consulta a oportunidade e responde com citação (tudo pelas fixtures do sandbox). */
const pedidoComFonte = (oppId, extra = '') => `Resuma a oportunidade [[TOOL:crm.getOpportunity:{"opportunityId":"${oppId}"}]] [[RESPOSTA:A oportunidade está no estágio informado [1].]] ${extra}`.trim();

const aguardarRun = async (env, token, runId, fim = ['COMPLETED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL'], tentativas = 60) => {
  let ultimo = null;
  for (let i = 0; i < tentativas; i += 1) {
    ultimo = await env.call('GET', `/ai/runs/${runId}`, token);
    if (ultimo.status === 200 && fim.includes(ultimo.body.data.status)) return ultimo;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return ultimo;
};

/** Envelhece os runs de uma conversa (superusuário do cluster descartável, sem os gatilhos de imutabilidade): só para provar a validade. */
async function envelhecerRuns(conversationId, horas) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query("UPDATE ai.ai_runs SET started_at = started_at - ($2 || ' hours')::interval WHERE conversation_id = $1", [conversationId, String(horas)]);
  } finally { await client.end(); }
}

module.exports = { envelhecerRuns, subir, encerrar, agenteAtivo, codigoNovo, pedidoComFonte, aguardarRun, criarOportunidadeCommitada, admin, POLITICA };
