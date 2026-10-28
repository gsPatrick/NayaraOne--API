'use strict';

/**
 * M9-D404 — templates versionados: o ciclo DRAFT -> PUBLISHED -> RETIRED vira regra do banco.
 *
 * Gatilho BEFORE UPDATE em marketing.templates: depois de sair de DRAFT nenhum campo de conteúdo muda (código, versão, tipo,
 * canal, corpo, variáveis, tokens de marca, referência oficial, hash); a única transição permitida é PUBLISHED -> RETIRED.
 * RETIRED é final. Em DRAFT o conteúdo ainda pode ser ajustado e o status só vai a PUBLISHED. Erro MK004
 * (MKT_TEMPLATE_IMMUTABLE), mapeado para HTTP 409 no errorHandler. Vale para qualquer caminho de escrita, não só para o serviço.
 *
 * Idempotente (CREATE OR REPLACE e DROP TRIGGER IF EXISTS), numa transação. O down só remove gatilho e função.
 */

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE OR REPLACE FUNCTION marketing.templates_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF OLD.status = 'DRAFT' THEN
            IF NEW.status NOT IN ('DRAFT', 'PUBLISHED') THEN
              RAISE EXCEPTION 'MKT_TEMPLATE_IMMUTABLE: o template em rascunho só pode ser publicado.' USING ERRCODE = 'MK004';
            END IF;
            RETURN NEW;
          END IF;
          IF NEW.code IS DISTINCT FROM OLD.code
             OR NEW.version_no IS DISTINCT FROM OLD.version_no
             OR NEW.kind IS DISTINCT FROM OLD.kind
             OR NEW.channel IS DISTINCT FROM OLD.channel
             OR NEW.body IS DISTINCT FROM OLD.body
             OR NEW.variables_json IS DISTINCT FROM OLD.variables_json
             OR NEW.brand_tokens_json IS DISTINCT FROM OLD.brand_tokens_json
             OR NEW.official_template_ref IS DISTINCT FROM OLD.official_template_ref
             OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
             OR NEW.group_id IS DISTINCT FROM OLD.group_id
             OR NEW.company_id IS DISTINCT FROM OLD.company_id
             OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
             OR NOT (NEW.status = OLD.status OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
            RAISE EXCEPTION 'MKT_TEMPLATE_IMMUTABLE: Template publicado não pode ser editado; crie uma nova versão.' USING ERRCODE = 'MK004';
          END IF;
          RETURN NEW;
        END
        $fn$`);
      await q('DROP TRIGGER IF EXISTS templates_immutable ON marketing.templates');
      await q(`CREATE TRIGGER templates_immutable BEFORE UPDATE ON marketing.templates
        FOR EACH ROW EXECUTE FUNCTION marketing.templates_immutable()`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TRIGGER IF EXISTS templates_immutable ON marketing.templates', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS marketing.templates_immutable()', { transaction });
    });
  },
};
