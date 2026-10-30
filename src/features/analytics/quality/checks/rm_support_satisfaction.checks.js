'use strict';

/** M9-D696 (3.3) — checks do read model rm_support_satisfaction: frescor, conciliação com a fonte, invariante, completude de `satisfaction_score`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_support_satisfaction', short: 'support_satisfaction', domain: 'SUPPORT', metrics: ['sup.satisfaction'],
  // Pedido concluído é pesquisa interna (nota de satisfação) OU avaliação pública (nota da plataforma): só o concluído sem nenhuma das duas notas é dado faltando.
  completeness: { field: 'satisfaction_score', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE satisfaction_score IS NULL AND public_rating IS NULL)::int AS nulls FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'COMPLETED'` },
  invariant: { rule: 'respostas não negativas, notas 4 ou 5 <= respostas e soma das notas entre 1 e 5 por resposta (mês aberto sem resposta, com zero, é válido)', violation: `responses < 0 OR positive > responses OR score_sum < responses OR score_sum > 5 * responses` }, signed: ['score_sum'],
});
