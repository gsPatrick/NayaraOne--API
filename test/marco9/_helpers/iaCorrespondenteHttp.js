'use strict';

// Ambiente HTTP da NAY Correspondente (M9-D039): sobe o app real no cluster descartável com as permissões dos perfis do seed de dois
// tenants, cria o agente ATIVO da definição de código (por SQL do superusuário do cluster descartável, com o orçamento pela rota) e um
// caso de financiamento commitado. Nunca chama MFA nem forja token.

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { admin, grant } = require('./aiHttpEnv');
const R = require('./iaRunApiEnv');
const { withTenantTransaction } = require('../../testHelpers');
const { DEFINITION } = require('../../../src/features/ai/agents/nay_correspondente');
const { criarCaso, exigir, envelhecer } = require('./iaCorrespondente');

const PERFIS = ['CI GESTOR', 'CI CHECKER', 'CI MAKER', 'CI LEITURA'];

/** Sobe o ambiente; só o gestor recebe `correspondent:read` (o maker consulta a NAY sem ele). */
async function subir(porta) {
  await admin("DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = ANY($1::text[]) AND p.code = 'correspondent:read'", [PERFIS]);
  await grant('CI GESTOR', ['correspondent:read']); // antes do login: as permissões vão no token
  return R.subir(porta);
}

/** Versão ATIVA da empresa com o conteúdo da definição (DRAFT, allowlist, HOMOLOGATED, ACTIVE) e o orçamento mensal pela rota. */
async function agenteAtivo(env, tenant) {
  const id = crypto.randomUUID();
  const d = DEFINITION;
  await admin(
    `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, system_policy, model_policy, data_scopes, limits, criticality, enabled, config_hash)
     VALUES ($1, $2, $3, $4, 1, 'DRAFT', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, false, $11)`,
    [id, tenant.groupId, tenant.companyId, d.code, d.purpose, d.systemPolicy, JSON.stringify(d.modelPolicy), JSON.stringify(d.dataScopes), JSON.stringify({ ...d.limits, max_runs_por_minuto_usuario: 200 }), d.criticality, crypto.randomBytes(32).toString('hex')]
  );
  for (const t of d.tools) {
    await admin(
      'INSERT INTO ai.agent_tools (group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, true)',
      [tenant.groupId, tenant.companyId, id, t.toolName, t.permissionCode, t.riskLevel, t.requiresHumanApproval]
    );
  }
  await admin("UPDATE ai.agents SET status = 'HOMOLOGATED', homologated_by = $2, homologated_at = now() WHERE id = $1", [id, tenant.userId]);
  await admin("UPDATE ai.agents SET status = 'ACTIVE', enabled = true, activated_by = $2, activated_at = now() WHERE id = $1", [id, tenant.userId]);
  const r = await env.call('POST', '/ai/budgets', env.tokens['A:gestor'], { agentCode: d.code, limitAmount: '500.00' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return d.code;
}

/** Caso commitado, parado há `dias` dias, com um documento obrigatório pendente. */
async function casoParado(tenant, dias = 10, documentType = 'COMPROVANTE_RENDA') {
  return withTenantTransaction(tenant, async (tx) => {
    const caso = await criarCaso(tenant, tx);
    await exigir(caso, tenant, tx, documentType);
    await envelhecer(caso, dias, tx);
    return caso;
  });
}

module.exports = { subir, agenteAtivo, casoParado, encerrar: R.encerrar, admin };
