'use strict';

// M9-D046 — fábricas dos testes do portão de liberação: duas pessoas com ai:admin (quem registra e quem aprova a produção), o registro de cada item pelo
// serviço (a mesma regra da rota) e a tentativa de ir a PRODUCAO pelo serviço de parâmetros (a trava de gravação).
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const service = require('../../../src/features/ai/releaseGates');
const { sequelize, q, prepararTenants, carregarPessoas } = require('../../helpers/aiAgents');

const agents = require('../../../src/features/ai/agents');
const agentsRepo = require('../../../src/features/ai/agents/agents.repository');

/** Aposenta (na transação do teste) os agentes ativos que outros testes deixaram gravados na empresa: o portão exige a avaliação de cada agente ativo. */
async function limpar(tenant, tx) {
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  for (const a of await agentsRepo.listActive(ctx, tx)) await agents.retire(ctx, a.code, a.version, tx).catch(() => null);
}

const GLOBAIS = ['DEV_DEPLOY', 'LAB_VALIDATION', 'RED_TEAM', 'PENTEST', 'PRIVACY_REVIEW'];

/** Pessoa que registra e pessoa que aprova a produção: dois usuários reais e distintos do seed. */
async function pessoas(tenant) {
  const rows = await q('SELECT id FROM core.users WHERE id <> :u ORDER BY email LIMIT 2', { u: tenant.userId });
  return { registra: { ...tenant }, aprova: { ...tenant, userId: rows[0].id }, outra: { ...tenant, userId: rows[1].id } };
}

const ctxAdmin = (p) => ({ groupId: p.groupId, companyId: p.companyId, userId: p.userId, permissions: ['ai:admin'] });

/** Registra e aprova um item pelo serviço. */
const aprovar = (p, tx, item, extra = {}) => service.register(ctxAdmin(p), { item, status: 'APPROVED', evidenceRef: 'QA-M9 evidência', ...extra }, tx);

/** Aprova os cinco itens globais com a pessoa informada. */
async function aprovarGlobais(p, tx, itens = GLOBAIS) {
  for (const item of itens) await aprovar(p, tx, item);
}

/** Vai a PRODUCAO pelo serviço de parâmetros (a trava de gravação roda); devolve a promessa. */
const irParaProducao = (p, tx) => upsertSetting('ia.ambiente', 'PRODUCAO', p, p.userId, tx);

module.exports = { limpar, GLOBAIS, pessoas, ctxAdmin, aprovar, aprovarGlobais, irParaProducao, service, sequelize, q, prepararTenants, carregarPessoas };
