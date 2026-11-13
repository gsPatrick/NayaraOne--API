'use strict';

/**
 * Livro do Marco 3 §3 "Entidades obrigatórias": as que o sistema já tinha com outro nome físico passam a existir também com o
 * nome do livro, como visões somente leitura sobre a tabela de verdade (security_invoker: valem o RLS e as permissões de
 * quem consulta). Nenhum dado é copiado; a escrita continua pela tabela de origem e pelos services.
 *   crm.interactions        -> crm.messages (linha do tempo de contato; summary = body; occurred_at do contato)
 *   crm.tasks               -> core.tasks de oportunidade (related_entity_type = 'crm.opportunities')
 *   crm.radars              -> crm.property_radars
 *   crm.service_occurrences -> crm.feedback_cases
 *   crm.loss_reasons        -> catálogo fechado de motivos de ganho, perda e desistência (opportunityOutcomeReason.validator.js;
 *                              o teste crm.livroEntidades.test.js reprova se a visão e o código divergirem)
 * crm.radar_matches é tabela própria (migration 20260101009972). Reversível.
 */
const LOSS_REASONS = [
  ['CLOSED_WON', 'PRICE_ACCEPTED', 'Preço aceito'], ['CLOSED_WON', 'FAST_DECISION', 'Decisão rápida'], ['CLOSED_WON', 'REFERRAL', 'Indicação'], ['CLOSED_WON', 'OTHER', 'Outro motivo'],
  ['CLOSED_LOST', 'PRICE_TOO_HIGH', 'Preço alto'], ['CLOSED_LOST', 'COMPETITOR', 'Concorrente'], ['CLOSED_LOST', 'FINANCING_DENIED', 'Financiamento negado'], ['CLOSED_LOST', 'LOCATION', 'Localização'], ['CLOSED_LOST', 'OTHER', 'Outro motivo'],
  ['WITHDRAWN', 'CLIENT_GAVE_UP', 'Cliente desistiu'], ['WITHDRAWN', 'NO_RESPONSE', 'Sem resposta'], ['WITHDRAWN', 'CHANGED_MIND', 'Mudou de ideia'], ['WITHDRAWN', 'OTHER', 'Outro motivo'],
];
const VIEWS = ['crm.interactions', 'crm.tasks', 'crm.radars', 'crm.service_occurrences', 'crm.loss_reasons'];

module.exports = {
  LOSS_REASONS,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE OR REPLACE VIEW crm.interactions WITH (security_invoker = true) AS
        SELECT id, group_id, company_id, person_id, opportunity_id, channel, direction, author_type, author_user_id,
               body AS summary, COALESCE(occurred_at, created_at) AS occurred_at, external_message_id, connection_id, conversation_id,
               status, delivery_status, purpose, created_by, created_at
          FROM crm.messages`);
      await q(`CREATE OR REPLACE VIEW crm.tasks WITH (security_invoker = true) AS
        SELECT * FROM core.tasks WHERE related_entity_type = 'crm.opportunities'`);
      await q('CREATE OR REPLACE VIEW crm.radars WITH (security_invoker = true) AS SELECT * FROM crm.property_radars');
      await q('CREATE OR REPLACE VIEW crm.service_occurrences WITH (security_invoker = true) AS SELECT * FROM crm.feedback_cases');
      const values = LOSS_REASONS.map(([o, c, l]) => `('${o}', '${c}', '${l}')`).join(', ');
      await q(`CREATE OR REPLACE VIEW crm.loss_reasons AS SELECT outcome_stage, code, label FROM (VALUES ${values}) AS r(outcome_stage, code, label)`);
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT ON ${VIEWS.join(', ')} TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    for (const v of [...VIEWS].reverse()) await queryInterface.sequelize.query(`DROP VIEW IF EXISTS ${v}`);
  },
};
