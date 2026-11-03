'use strict';

/**
 * Migration: endurece o gatilho protect_dimob_batch. Em lote FECHADO sem modelo, a única alteração aceita é o
 * preenchimento inicial de file_model_json E file_model_hash (as duas, no mesmo UPDATE, de nulo para preenchido),
 * com TODAS as demais colunas idênticas (comparação da linha inteira, inclusive colunas futuras). Modelo já
 * preenchido nunca muda. GRANT e RLS da tabela não mudam (só a função do gatilho).
 */
const FUNCAO_NOVA = `CREATE OR REPLACE FUNCTION "correspondent".protect_dimob_batch() RETURNS trigger AS $$
  BEGIN
    IF OLD.file_model_json IS NOT NULL AND (NEW.file_model_json IS DISTINCT FROM OLD.file_model_json OR NEW.file_model_hash IS DISTINCT FROM OLD.file_model_hash) THEN
      RAISE EXCEPTION 'O modelo do arquivo de um batch DIMOB não pode ser alterado: gere uma nova versão.';
    END IF;
    IF OLD.status = 'CLOSED' THEN
      IF OLD.file_model_json IS NULL AND OLD.file_model_hash IS NULL
         AND NEW.file_model_json IS NOT NULL AND NEW.file_model_hash IS NOT NULL
         AND (to_jsonb(NEW) - 'file_model_json' - 'file_model_hash') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'file_model_json' - 'file_model_hash') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Batch DIMOB fechado não pode ser alterado: gere uma nova versão.';
    END IF;
    IF NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.reference_year <> OLD.reference_year OR NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'O hash, o ano e a versão de um batch DIMOB não podem ser alterados.';
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql`;

const FUNCAO_ANTERIOR = `CREATE OR REPLACE FUNCTION "correspondent".protect_dimob_batch() RETURNS trigger AS $$
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
  END; $$ LANGUAGE plpgsql`;

module.exports = {
  up: async (queryInterface) => { await queryInterface.sequelize.query(FUNCAO_NOVA); },
  down: async (queryInterface) => { await queryInterface.sequelize.query(FUNCAO_ANTERIOR); },
};
