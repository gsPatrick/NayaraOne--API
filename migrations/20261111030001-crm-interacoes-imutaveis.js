'use strict';

/**
 * Livro do Marco 3 §18 ("Apagar interação comprometedora — Soft delete/audit; críticos imutáveis"; CAD-18) e §2 CRMX-005 ("Preço,
 * atendimento, visita, proposta e perda permanecem auditáveis"). A interação (crm.messages, a implementação de crm.interactions) já
 * não tinha rota de exclusão nem de edição do conteúdo; agora o BANCO também recusa, para qualquer papel que não seja superusuário
 * (o runtime da aplicação e o de migração):
 *   - DELETE de interação;
 *   - UPDATE do conteúdo crítico: texto, direção, canal, tipo e usuário autor, quando aconteceu, finalidade e o id externo já gravado.
 * Continua permitido o que o fluxo de entrega muda (status, status de entrega, motivo da falha, despacho, conexão, canal alternativo,
 * mídia) e a ligação do id do fornecedor quando ainda estava vazia (messaging.bind.js). Reversível.
 */
const FN = 'crm.messages_criticos_imutaveis';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
            RETURN COALESCE(NEW, OLD);
          END IF;
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'CRM_INTERACTION_IMMUTABLE: interação não pode ser apagada (livro do Marco 3, §18).' USING ERRCODE = 'P0001';
          END IF;
          IF NEW.body IS DISTINCT FROM OLD.body
            OR NEW.direction IS DISTINCT FROM OLD.direction
            OR NEW.channel IS DISTINCT FROM OLD.channel
            OR NEW.author_type IS DISTINCT FROM OLD.author_type
            OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
            OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
            OR NEW.purpose IS DISTINCT FROM OLD.purpose
            OR (OLD.external_message_id IS NOT NULL AND NEW.external_message_id IS DISTINCT FROM OLD.external_message_id) THEN
            RAISE EXCEPTION 'CRM_INTERACTION_IMMUTABLE: o conteúdo da interação não pode ser alterado (livro do Marco 3, §18).' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$`);
      await q('DROP TRIGGER IF EXISTS messages_criticos_imutaveis ON crm.messages');
      await q(`CREATE TRIGGER messages_criticos_imutaveis BEFORE UPDATE OR DELETE ON crm.messages FOR EACH ROW EXECUTE FUNCTION ${FN}()`);
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TRIGGER IF EXISTS messages_criticos_imutaveis ON crm.messages', { transaction });
      await sequelize.query(`DROP FUNCTION IF EXISTS ${FN}()`, { transaction });
    });
  },
};
