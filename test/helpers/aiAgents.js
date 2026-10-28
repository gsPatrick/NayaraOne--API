'use strict';

// Apoio dos testes da M9-D004 (agentes versionados). Tudo roda com nayara_runtime (RLS real) em transação com rollback.

const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../src/models');
const { prepararTenants, expectDbError } = require('./marketingExecucao');

const uid = () => crypto.randomUUID();
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });

// A trilha de auditoria tem FK para core.users: as "pessoas" dos testes são usuários reais do seed, uma diferente a cada ctxDe().
let pessoas = [];
let proxima = 0;
async function carregarPessoas() {
  pessoas = (await q('SELECT id FROM core.users ORDER BY email LIMIT 6')).map((r) => r.id);
  if (pessoas.length < 3) throw new Error('o seed precisa de pelo menos 3 usuários');
}
/** ctx de uma pessoa (criador, homologador e ativador são pessoas diferentes se não passar userId). */
const ctxDe = (tenant, userId) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: userId || pessoas[proxima++ % pessoas.length] });

const BASE_AGENT = {
  purpose: 'Responder sobre pipeline comercial com fontes.',
  systemPolicy: 'Nunca invente dados. Cite as fontes.',
  modelPolicy: { capability: 'chat', maxOutputTokens: 800, cacheableTaskTypes: [] },
  dataScopes: ['crm.opportunities'],
  limits: {},
  criticality: 'NON_CRITICAL',
};

const FERRAMENTA = {
  toolName: 'crm.buscar_oportunidades', permissionCode: 'ai:read', riskLevel: 'LOW', requiresHumanApproval: false, enabled: true,
};

/** Insere uma versão de agente da empresa direto por SQL (para testar o banco, sem o serviço). */
async function inserirAgente(tenant, tx, extra = {}) {
  const id = uid();
  const campos = {
    id, group_id: tenant.groupId, company_id: tenant.companyId, code: extra.code || `T_${id.slice(0, 8).toUpperCase()}`, version: extra.version || 1,
    status: extra.status || 'DRAFT', purpose: extra.purpose === undefined ? 'Teste' : extra.purpose, criticality: 'NON_CRITICAL',
    config_hash: 'a'.repeat(64),
  };
  await run(
    `INSERT INTO ai.agents (id, group_id, company_id, code, version, status, purpose, criticality, config_hash)
     VALUES (:id, :group_id, :company_id, :code, :version, 'DRAFT', :purpose, :criticality, :config_hash)`,
    campos, tx
  );
  return campos;
}

/** Leva a linha por SQL até o estado pedido, passando pelas transições válidas. */
async function levarPara(id, status, tx) {
  const passos = { HOMOLOGATED: ['HOMOLOGATED'], ACTIVE: ['HOMOLOGATED', 'ACTIVE'] }[status] || [];
  for (const passo of passos) {
    await run(
      passo === 'HOMOLOGATED'
        ? "UPDATE ai.agents SET status='HOMOLOGATED', homologated_by=:u, homologated_at=now() WHERE id=:id"
        : "UPDATE ai.agents SET status='ACTIVE', enabled=true, activated_by=:u, activated_at=now() WHERE id=:id",
      { id, u: uid() }, tx
    );
  }
}

module.exports = { carregarPessoas, sequelize, uid, q, run, ctxDe, BASE_AGENT, FERRAMENTA, inserirAgente, levarPara, prepararTenants, expectDbError };
