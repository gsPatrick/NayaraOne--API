'use strict';

// M9-D441 — migration 790: o índice parcial da janela de atendimento do canSend (mensagens INBOUND) existe, é idempotente e reversível. Só no banco descartável (usa o superusuário).
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../../../../src/models');
const carga = require('../../_helpers/mktCarga');

after(async () => { await sequelize.close(); });

test('migration_790_cria_o_indice_da_janela_de_atendimento_idempotente_e_reversivel', { skip: carga.SKIP }, async () => {
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const migration = require(path.resolve(__dirname, '../../../../migrations/20260101000790-crm-messages-inbound-window-index.js'));
  const qi = admin.getQueryInterface();
  const definicao = async () => (await admin.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'crm' AND tablename = 'messages' AND indexname = 'crm_messages_inbound_window_idx'"))[0][0];
  try {
    const existente = await definicao();
    assert.ok(existente, 'o índice existe depois das migrations');
    assert.match(existente.indexdef, /\(company_id, person_id, channel, created_at DESC\) WHERE \(\(direction\)::text = 'INBOUND'::text\)/);
    await migration.up(qi); // segunda vez: sem erro
    await migration.down(qi);
    assert.equal(await definicao(), undefined, 'o down remove o índice');
    await migration.up(qi);
    assert.ok(await definicao(), 'o up recria o índice');
    // as políticas da tabela não mudam (RLS FORCE continua)
    const [[rls]] = await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'crm' AND c.relname = 'messages'");
    assert.deepEqual([rls.relrowsecurity, rls.relforcerowsecurity], [true, true]);
  } finally { await admin.close(); }
});
