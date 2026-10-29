'use strict';

// Fábricas da recomendação da NAY (M9-D007). Tudo roda com nayara_runtime (RLS real) em transação com rollback.

const { uid, q, run } = require('../../helpers/aiRuns');

const INFORMATIVA = 'NEXT_ACTION';
const COM_ACAO = 'PURCHASE_SUGGESTION';

/** Entrada de createRecommendation com valores válidos; `extra` sobrescreve. */
function dadosRec(extra = {}) {
  return {
    agentCode: 'NAY_TESTE', relatedEntityType: 'Opportunity', relatedEntityId: uid(), recommendationType: INFORMATIVA,
    title: 'Ligar para o cliente hoje', rationale: 'O cliente abriu a proposta duas vezes.', confidence: 0.82, riskLevel: 'LOW', ...extra,
  };
}

/** Recomendação com ação proposta (exige ai:approve para decidir). */
function dadosComAcao(extra = {}) {
  return dadosRec({
    recommendationType: COM_ACAO, riskLevel: 'MEDIUM', title: 'Comprar 20 sacos de cimento',
    proposedAction: { tool: 'procurement.criar_requisicao', args: { quantidade: 20 }, snapshot: { saldo: 3 }, snapshot_hash: 'a'.repeat(64) }, ...extra,
  });
}

const eventosDe = (tipo, id, tx) => q("SELECT * FROM integration.outbox_events WHERE event_type = :t AND aggregate_id = :id", { t: tipo, id }, tx);
const lerRec = async (id, tx) => (await q('SELECT * FROM ai.ai_recommendations WHERE id = :id', { id }, tx))[0];
const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });

/** Garante o vínculo ativo das pessoas de teste com a empresa (o destinatário da recomendação precisa ser da empresa). */
async function vincular(tenant, tx, ...userIds) {
  for (const userId of userIds) {
    const [ja] = await q("SELECT 1 FROM core.user_memberships WHERE user_id = :u AND company_id = :c AND status = 'ACTIVE' AND deleted_at IS NULL", { u: userId, c: tenant.companyId }, tx);
    if (!ja) await run("INSERT INTO core.user_memberships (id, group_id, company_id, user_id, status) VALUES (gen_random_uuid(), :g, :c, :u, 'ACTIVE')", { g: tenant.groupId, c: tenant.companyId, u: userId }, tx);
  }
}

module.exports = { vincular, INFORMATIVA, COM_ACAO, dadosRec, dadosComAcao, eventosDe, lerRec, comPerm };
