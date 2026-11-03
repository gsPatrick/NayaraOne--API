'use strict';

/**
 * Migration: cada versão do lote DIMOB guarda o MODELO do arquivo com que foi gerada (colunas, separador,
 * aviso e rótulo do layout) e o hash desse modelo. Mudar as configurações da empresa depois não altera mais
 * a exportação de um lote já gerado/fechado: só a PRÓXIMA geração (nova versão) usa o modelo novo.
 * Lotes antigos ficam com modelo nulo e são "congelados" na primeira exportação; o gatilho de proteção
 * passa a permitir exatamente essa gravação única (e nenhuma outra) num lote fechado.
 * GRANT e RLS da tabela não mudam (só colunas novas).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = { tableName: 'dimob_batches', schema: 'correspondent' };
    const q = (sql) => queryInterface.sequelize.query(sql);
    await queryInterface.addColumn(table, 'file_model_json', {
      type: Sequelize.JSONB,
      allowNull: true,
      comment: 'Modelo do arquivo desta versão: layout, colunas, separador e aviso. Nulo em lote antigo até a primeira exportação.',
    });
    await queryInterface.addColumn(table, 'file_model_hash', {
      type: Sequelize.STRING(64),
      allowNull: true,
      comment: 'SHA-256 do modelo do arquivo (identifica qual modelo gerou esta versão).',
    });
    await q(`CREATE OR REPLACE FUNCTION "correspondent".protect_dimob_batch() RETURNS trigger AS $$
      BEGIN
        IF OLD.file_model_json IS NOT NULL AND (NEW.file_model_json IS DISTINCT FROM OLD.file_model_json OR NEW.file_model_hash IS DISTINCT FROM OLD.file_model_hash) THEN
          RAISE EXCEPTION 'O modelo do arquivo de um batch DIMOB não pode ser alterado: gere uma nova versão.';
        END IF;
        IF OLD.status = 'CLOSED' THEN
          IF OLD.file_model_json IS NULL AND NEW.file_model_json IS NOT NULL AND NEW.status = 'CLOSED'
             AND NEW.snapshot_hash = OLD.snapshot_hash AND NEW.version = OLD.version
             AND NEW.reference_year = OLD.reference_year AND NEW.layout_version = OLD.layout_version THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'Batch DIMOB fechado não pode ser alterado: gere uma nova versão.';
        END IF;
        IF NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.reference_year <> OLD.reference_year OR NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'O hash, o ano e a versão de um batch DIMOB não podem ser alterados.';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
  },

  down: async (queryInterface) => {
    const table = { tableName: 'dimob_batches', schema: 'correspondent' };
    await queryInterface.sequelize.query(`CREATE OR REPLACE FUNCTION "correspondent".protect_dimob_batch() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'CLOSED' THEN
          RAISE EXCEPTION 'Batch DIMOB fechado não pode ser alterado: gere uma nova versão.';
        END IF;
        IF NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.reference_year <> OLD.reference_year OR NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'O hash, o ano e a versão de um batch DIMOB não podem ser alterados.';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await queryInterface.removeColumn(table, 'file_model_hash');
    await queryInterface.removeColumn(table, 'file_model_json');
  },
};
