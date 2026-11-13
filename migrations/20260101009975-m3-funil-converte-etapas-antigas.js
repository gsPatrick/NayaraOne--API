'use strict';

/**
 * DI-M3-FUNIL-1 (livro do Marco 3 §10): oportunidades gravadas antes do catálogo fechado do funil com códigos fora do livro
 * passam para a etapa do livro. Leitura da homologação em 10/11/2026 (somente leitura): NEGOTIATION (44), NOVO (3) e LOST
 * (2) na empresa Dev. Mapa: NOVO→NEW, CONTATO→QUALIFIED, VISITA→VISIT_SCHEDULED, PROPOSTA→PROPOSAL, QUALIFYING→QUALIFIED,
 * VISIT→VISIT_SCHEDULED, NEGOTIATION→PROPOSAL ("Proposta aberta" é a negociação), GANHO/WON→CLOSED_WON, PERDIDO/LOST→CLOSED_LOST
 * (terminal sem data de fechamento recebe a última atualização da linha). Cada linha convertida deixa um registro no audit_log
 * com antes/depois. Valor desconhecido fora do mapa não é tocado (continua legível; só vale o catálogo quando a etapa mudar).
 * Mesmo padrão de RLS de 20260101000530 (NO FORCE só durante a conversão). O down não desfaz (os registros de auditoria
 * guardam o valor anterior).
 */
const MAPA = {
  NOVO: 'NEW', CONTATO: 'QUALIFIED', VISITA: 'VISIT_SCHEDULED', PROPOSTA: 'PROPOSAL', QUALIFYING: 'QUALIFIED', VISIT: 'VISIT_SCHEDULED',
  // DI-M3CA-3 (11/11/2026): o funil grava os códigos do livro WON e LOST; GANHO/PERDIDO vão direto para eles e WON/LOST já são do
  // livro (não são convertidos). A 20261111031001 converte o que esta migration gravou antes como CLOSED_WON/CLOSED_LOST.
  NEGOTIATION: 'PROPOSAL', GANHO: 'WON', PERDIDO: 'LOST',
};

module.exports = {
  MAPA,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('ALTER TABLE crm.opportunities NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE audit.audit_log NO FORCE ROW LEVEL SECURITY');
      try {
        for (const [antigo, livro] of Object.entries(MAPA)) {
          const terminal = livro === 'WON' || livro === 'LOST';
          const [linhas] = await q(
            `UPDATE crm.opportunities o SET stage = :livro, closed_at = ${terminal ? 'COALESCE(o.closed_at, o.updated_at)' : 'o.closed_at'}, updated_at = now()
               FROM (SELECT id, stage AS antes, closed_at AS antes_fechamento FROM crm.opportunities WHERE upper(btrim(stage)) = :antigo FOR UPDATE) v
              WHERE o.id = v.id
              RETURNING o.id, o.group_id, o.company_id, v.antes, v.antes_fechamento, o.closed_at`,
            { livro, antigo }
          );
          for (const l of linhas) {
            await q(
              `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
               VALUES (gen_random_uuid(), :g, :c, NULL, 'opportunity.stage_migrated', 'Opportunity', :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`,
              {
                g: l.group_id, c: l.company_id, id: l.id,
                b: JSON.stringify({ stage: l.antes, closedAt: l.antes_fechamento }),
                a: JSON.stringify({ stage: livro, closedAt: l.closed_at }),
                r: `Migration 20260101009975 (DI-M3-FUNIL-1): etapa "${l.antes}" fora do funil do livro do Marco 3 §10 convertida para ${livro}.`,
              }
            );
          }
        }
      } finally {
        await q('ALTER TABLE crm.opportunities FORCE ROW LEVEL SECURITY');
        await q('ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY');
      }
    });
  },
  async down() {
    // A conversão não é desfeita: o valor anterior de cada linha está no audit_log (action opportunity.stage_migrated).
  },
};
