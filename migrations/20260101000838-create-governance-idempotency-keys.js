'use strict';

/**
 * M9-D843 — governance.idempotency_keys: a chave `Idempotency-Key` de uma criação ou ação sensível (M9-D843 §3.3). UNIQUE (company_id, scope, key), onde `scope` = credencial (usuário) +
 * método + rota; `request_hash` é o SHA-256 do corpo canônico (mesma chave com outro corpo = 422). A linha nasce na MESMA transação do efeito (se o efeito desfaz, a chave some);
 * a resposta original (`response_status`, `response_body`) é gravada em seguida e devolvida em repetições até `expires_at` (24 h por padrão). RLS + FORCE pela função do alicerce. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        scope varchar(300) NOT NULL,
        key varchar(128) NOT NULL,
        request_hash char(64) NOT NULL,
        response_status smallint NULL,
        response_body jsonb NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_idempotency_scope_key_uq UNIQUE (company_id, scope, key),
        CONSTRAINT gov_idempotency_key_len_chk CHECK (char_length(key) BETWEEN 8 AND 128)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_idempotency_expires_idx ON governance.idempotency_keys (expires_at)');
      await q("SELECT governance.apply_tenant_rls('governance.idempotency_keys'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.idempotency_keys');
  },
};
