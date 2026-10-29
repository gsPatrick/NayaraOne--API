'use strict';

/**
 * M9-D009 — gatilhos de ai.memories. Nada se apaga (DELETE e TRUNCATE recusados, AI052 -> 409 AI_MEMORY_DELETE_FORBIDDEN). O conteúdo
 * é imutável: só mudam o estado e os campos da invalidação (AI051). Máquina: ACTIVE vai para INVALIDATED, EXPIRED ou SUPERSEDED;
 * os três são finais (memória expirada ou invalidada não volta a valer). Corrigir é criar outra linha.
 */
const FUNCOES = [
  `CREATE OR REPLACE FUNCTION ai.memories_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'AI_MEMORY_DELETE_FORBIDDEN: memória não é apagada; invalide-a' USING ERRCODE = 'AI052';
     END IF;
     IF (to_jsonb(NEW) - 'status' - 'invalidated_by' - 'invalidated_at' - 'invalidation_reason' - 'updated_at' - 'updated_by')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'invalidated_by' - 'invalidated_at' - 'invalidation_reason' - 'updated_at' - 'updated_by') THEN
       RAISE EXCEPTION 'AI_MEMORY_IMMUTABLE: o conteúdo da memória não muda; corrija criando outra versão' USING ERRCODE = 'AI051';
     END IF;
     IF OLD.status <> NEW.status THEN
       IF OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('INVALIDATED', 'EXPIRED', 'SUPERSEDED') THEN
         RAISE EXCEPTION 'AI_MEMORY_STATE: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI051';
       END IF;
       IF NEW.status = 'INVALIDATED' THEN NEW.invalidated_at := COALESCE(NEW.invalidated_at, CURRENT_TIMESTAMP); END IF;
     ELSIF (NEW.invalidated_by, NEW.invalidated_at, NEW.invalidation_reason) IS DISTINCT FROM (OLD.invalidated_by, OLD.invalidated_at, OLD.invalidation_reason) THEN
       RAISE EXCEPTION 'AI_MEMORY_STATE: a invalidação já registrada não muda' USING ERRCODE = 'AI051';
     END IF;
     RETURN NEW;
   END
   $f$`,
  `CREATE OR REPLACE FUNCTION ai.memories_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $f$
   BEGIN
     RAISE EXCEPTION 'AI_MEMORY_DELETE_FORBIDDEN: memória não é apagada; invalide-a' USING ERRCODE = 'AI052';
   END
   $f$`,
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const f of FUNCOES) await q(f);
      await q('DROP TRIGGER IF EXISTS memories_guard ON ai.memories');
      await q('CREATE TRIGGER memories_guard BEFORE UPDATE OR DELETE ON ai.memories FOR EACH ROW EXECUTE FUNCTION ai.memories_guard()');
      await q('DROP TRIGGER IF EXISTS memories_no_truncate ON ai.memories');
      await q('CREATE TRIGGER memories_no_truncate BEFORE TRUNCATE ON ai.memories FOR EACH STATEMENT EXECUTE FUNCTION ai.memories_no_truncate()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS memories_guard ON ai.memories');
      await q('DROP TRIGGER IF EXISTS memories_no_truncate ON ai.memories');
      await q('DROP FUNCTION IF EXISTS ai.memories_guard()');
      await q('DROP FUNCTION IF EXISTS ai.memories_no_truncate()');
    });
  },
};
