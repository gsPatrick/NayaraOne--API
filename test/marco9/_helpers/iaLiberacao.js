'use strict';

// M9-D046 — apoio dos testes: leva a empresa a um portão de liberação COMPLETO (todos os itens APROVADOS, aprovação final de outra pessoa), por SQL
// dentro da transação do teste (rollback), para os testes que precisam de `ia.ambiente` = PRODUCAO. Os testes do próprio portão não usam isto.
const { sequelize, q, run } = require('../../helpers/aiAgents');
const { computeMissing } = require('../../../src/features/ai/releaseGates/releaseGates.requirements');

const ref = (n) => (n.ref ? n.ref : null);

/** Outra pessoa (qualquer usuário que não seja `userId`), para a aprovação final. */
async function outraPessoa(userId, tx) {
  const [row] = await q('SELECT id FROM core.users WHERE id <> :u ORDER BY id LIMIT 1', { u: userId }, tx);
  return row.id;
}

async function inserir(tenant, tx, { item, scopeRef, quem, nivel = 'COMPANY' }) {
  const scopeType = item === 'AGENT_EVALUATION' ? 'AGENT' : item === 'PROVIDER_REVIEW' ? 'PROVIDER' : 'GLOBAL';
  await run(
    `INSERT INTO ai.release_gates (group_id, company_id, scope_type, scope_ref, item, status, evidence_ref, approved_by, approved_at, registered_by)
     VALUES (:g, :c, :t, :r, :i, 'APPROVED', 'QA-M9 evidência de teste', :q, now(), :q)
     ON CONFLICT DO NOTHING`,
    { g: tenant.groupId, c: nivel === 'GROUP' ? null : tenant.companyId, t: scopeType, r: scopeRef || null, i: item, q: quem }, tx
  );
}

/** Aprova todos os itens que faltam (os globais, um por agente ativo e um por provedor real) e a aprovação final por outra pessoa. */
async function liberarProducao(tenant, tx, { extraAgents = [] } = {}) {
  const { need } = await computeMissing(tenant, tx, { extraAgents, includeFinal: false });
  for (const n of need) await inserir(tenant, tx, { item: n.item, scopeRef: ref(n), quem: tenant.userId });
  await inserir(tenant, tx, { item: 'PRODUCTION_APPROVAL', scopeRef: null, quem: await outraPessoa(tenant.userId, tx) });
}

module.exports = { liberarProducao, inserir, outraPessoa, sequelize };
