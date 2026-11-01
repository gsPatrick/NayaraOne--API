'use strict';

// M9-D800 (reabertura R4-L3) — o catálogo de RLS também cobre as tabelas SEM company_id: toda tabela de usuário
// sem a coluna precisa de RLS + FORCE + política OU de uma exceção explícita e justificada abaixo (DI-D800-R4L3).
// O teste lê só o catálogo do Postgres; rode em banco descartável (scripts/withDisposableDb.js).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../testHelpers');

after(async () => { await sequelize.close(); });

// Exceção = tabela sem company_id que fica fora de RLS+FORCE. A justificativa é obrigatória; o estado esperado é
// travado (se alguém ligar RLS ou criar política, o teste obriga a revisar a exceção).
const EXCEPTIONS = {
  'core.groups': 'raiz do tenant: a linha É o grupo; lida no login/seleção de empresa antes de existir contexto de tenant',
  'core.users': 'identidade global: o e-mail é único na plataforma e o login acontece antes de existir contexto de tenant; o vínculo por empresa fica em core.user_memberships (RLS+FORCE)',
  'core.permissions': 'catálogo global de permissões do produto, sem dado de empresa; as concessões por empresa ficam em core.roles/role_permissions por papel',
  'core.role_permissions': 'ligação papel-permissão; só é alcançada por core.roles (RLS+FORCE) e não guarda dado de negócio',
  'integration.providers': 'catálogo global de fornecedores (D200): RLS ligada com leitura aberta e escrita só de plataforma; sem FORCE porque o dono da migration/seed precisa gravar o catálogo',
  'public.SequelizeMeta': 'controle do runner de migrations; não é dado de negócio',
  'real_estate.property_addresses': 'não tem empresa própria: é 1:1 com real_estate.properties (RLS+FORCE) e todo acesso passa pelo JOIN com properties; a linha é criada antes do imóvel, então uma política por EXISTS recusaria o INSERT (DI-D800-R4L3-1)',
  'correspondent.webhook_pending': 'webhook de financiamento de um caso ainda desconhecido: chega sem JWT e sem empresa (é isso que a tabela guarda até o caso existir), então não há tenant para aplicar; só o worker de webhook a lê, nunca uma rota de tenant (DI-D800-R4L3-2)',
};

async function tablesWithoutCompany() {
  const [rows] = await sequelize.query(`
    SELECT n.nspname AS schema, c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = n.nspname AND k.table_name = c.relname AND k.column_name = 'company_id')
     ORDER BY 1, 2`);
  return rows;
}

test('m9d800 toda tabela sem company_id tem RLS+FORCE+política ou exceção justificada', async () => {
  const rows = await tablesWithoutCompany();
  assert.ok(rows.length > 8, 'sanidade: o catálogo devolveu tabelas');
  const offenders = rows.filter((r) => !(r.rls && r.force && r.policies > 0) && !EXCEPTIONS[`${r.schema}.${r.table}`])
    .map((r) => `${r.schema}.${r.table} (rls=${r.rls}, force=${r.force}, políticas=${r.policies})`);
  assert.deepEqual(offenders, [], `tabelas sem company_id fora de RLS+FORCE e sem exceção justificada: ${offenders.join('; ')}`);
});

test('m9d800 cada exceção existe, tem justificativa e continua sem RLS completa (exceção velha sai da lista)', async () => {
  const rows = await tablesWithoutCompany();
  const byName = new Map(rows.map((r) => [`${r.schema}.${r.table}`, r]));
  for (const [name, why] of Object.entries(EXCEPTIONS)) {
    assert.ok(why.length > 30, `${name}: justificativa obrigatória`);
    const row = byName.get(name);
    assert.ok(row, `${name}: a exceção aponta para uma tabela que não existe mais`);
    assert.ok(!(row.rls && row.force && row.policies > 0), `${name}: já tem RLS+FORCE+política; retire a exceção`);
  }
});

test('m9d800 as tabelas de negócio sensíveis sem empresa estão nomeadas na lista (endereço do imóvel e webhook pendente)', () => {
  assert.ok(EXCEPTIONS['real_estate.property_addresses'].includes('DI-D800-R4L3-1'));
  assert.ok(EXCEPTIONS['correspondent.webhook_pending'].includes('DI-D800-R4L3-2'));
});
