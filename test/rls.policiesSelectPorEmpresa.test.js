'use strict';

// Guarda de catálogo contra o defeito achado em people.persons (10/11/2026): no PostgreSQL, política FOR ALL vale também
// para SELECT e políticas PERMISSIVAS se somam com OR. Uma política FOR ALL só por group_id, ao lado de uma de SELECT por
// empresa, abre a leitura para o grupo inteiro. Este teste percorre pg_policies e, para TODA tabela com coluna company_id,
// exige que cada política permissiva que vale para SELECT (cmd ALL ou SELECT) restrinja por company_id, direto ou pela
// company_scope_allows. As exceções são lookups deliberados por token/usuário, que não abrem a tabela para uma empresa:
// cada uma está listada com o predicado exato esperado, para que mudar o predicado também quebre o teste.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('./testHelpers');

after(async () => { await sequelize.close(); });

const LOOKUPS_DELIBERADOS = {
  // A pessoa lê as PRÓPRIAS associações (login e troca de empresa), antes de ter empresa no contexto.
  'core.user_memberships:self_membership_lookup': /^\(user_id = \(NULLIF\(current_setting\('app\.user_id'::text, true\), ''::text\)\)::uuid\)$/,
  // Autenticação de cliente de API pela chave: só com o interruptor de lookup ligado pelo middleware de API.
  'governance.api_clients:api_client_lookup': /^\(current_setting\('app\.api_client_lookup'::text, true\) = 'on'::text\)$/,
  'governance.api_consumers:api_consumer_client_lookup': /^\(\(current_setting\('app\.api_client_lookup'::text, true\) = 'on'::text\) AND \(client_id IS NOT NULL\)\)$/,
  // Link público compartilhado: acha só a linha do hash do token apresentado.
  'governance.share_links:share_token_lookup': /^\(\(token_hash\)::text = NULLIF\(current_setting\('app\.share_token_hash'::text, true\), ''::text\)\)$/,
  // Webhook de entrada: acha só a conexão do canal apresentado.
  'integration.connections:webhook_channel_lookup': /^\(\(webhook_channel IS NOT NULL\) AND \(\(webhook_channel\)::text = NULLIF\(current_setting\('app\.webhook_channel_lookup'::text, true\), ''::text\)\)\)$/,
};

async function politicasDeLeitura() {
  const [linhas] = await sequelize.query(`
    SELECT p.schemaname AS schema, p.tablename AS tabela, p.policyname AS politica, p.cmd, p.permissive, p.qual
      FROM pg_policies p
     WHERE p.cmd IN ('ALL', 'SELECT')
       AND EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = p.schemaname AND c.table_name = p.tablename AND c.column_name = 'company_id')
     ORDER BY 1, 2, 3`);
  return linhas;
}

test('RLS: toda política que libera SELECT numa tabela com company_id restringe por empresa (fora os lookups deliberados)', async () => {
  const linhas = await politicasDeLeitura();
  assert.ok(linhas.length > 100, `catálogo inesperadamente pequeno (${linhas.length} políticas): o teste não estaria provando nada`);
  const abertas = linhas.filter((l) => l.permissive === 'PERMISSIVE' && !/company_id/.test(l.qual || '') && !LOOKUPS_DELIBERADOS[`${l.schema}.${l.tabela}:${l.politica}`]);
  assert.deepEqual(
    abertas.map((l) => `${l.schema}.${l.tabela} ${l.politica} (${l.cmd}): ${l.qual}`),
    [],
    'política permissiva que vale para SELECT sem company_id libera a leitura além da empresa (lembre: FOR ALL inclui SELECT e políticas permissivas somam com OR)'
  );
});

test('RLS: os lookups deliberados continuam com o predicado exato (mudou o predicado, revise o isolamento)', async () => {
  const linhas = await politicasDeLeitura();
  for (const [chave, esperado] of Object.entries(LOOKUPS_DELIBERADOS)) {
    const [tab, pol] = chave.split(':');
    const linha = linhas.find((l) => `${l.schema}.${l.tabela}` === tab && l.politica === pol);
    assert.ok(linha, `lookup ${chave} sumiu do catálogo: retire-o da lista de exceções`);
    assert.equal(linha.cmd, 'SELECT', `${chave} tem de ser só SELECT`);
    assert.match(linha.qual, esperado, `${chave} mudou de predicado: ${linha.qual}`);
  }
});

test('RLS: people.persons tem leitura por empresa e escrita por comando, nenhuma política FOR ALL', async () => {
  const [linhas] = await sequelize.query(`
    SELECT policyname AS politica, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'people' AND tablename = 'persons' ORDER BY 1`);
  assert.deepEqual(linhas.map((l) => `${l.politica}:${l.cmd}`), [
    'persons_company_delete:DELETE', 'persons_company_insert:INSERT', 'persons_company_select:SELECT', 'persons_company_update:UPDATE',
  ]);
  for (const l of linhas) {
    for (const expr of [l.qual, l.with_check].filter(Boolean)) {
      assert.match(expr, /group_id = /, `${l.politica}: falta o grupo`);
      assert.match(expr, /company_scope_allows\(company_id/, `${l.politica}: falta o escopo da empresa`);
    }
  }
  const [[rls]] = await sequelize.query("SELECT relrowsecurity AS ena, relforcerowsecurity AS frc FROM pg_class WHERE oid = 'people.persons'::regclass");
  assert.equal(rls.ena, true);
  assert.equal(rls.frc, true);
});
