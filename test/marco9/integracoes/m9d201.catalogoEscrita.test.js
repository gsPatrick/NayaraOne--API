'use strict';

// Marco 9, M9-D201 (reabertura M1) — as 14 famílias semeadas são catálogo GLOBAL: a empresa lê, não escreve; quem escreve (plataforma) consegue editar uma
// linha semeada (antes o PATCH devolvia 422 por a linha ficar invisível). Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, withRollbackTenantTransaction } = require('../../testHelpers');
const providers = require('../../../src/features/integrations/registry/providers.service');
const { IntegrationProvider } = require('../../../src/models');
const { setupEnv, teardownEnv } = require('../../helpers/integrationsRegistryEnv');

let tenant;
let ctx;
let outra;
before(async () => { ({ tenant, ctx, otherTenant: outra } = await setupEnv()); });
after(async () => { await teardownEnv(tenant); await sequelize.close(); });

test('catalogo_semeado_e_lido_pelas_duas_empresas', async () => {
  assert.ok(outra, 'o seed de duas empresas precisa existir');
  for (const t of [tenant, outra]) {
    const dominios = await withRollbackTenantTransaction(t, async (tx) => (await providers.listProviders({}, tx)).map((p) => p.domain));
    assert.equal(new Set(dominios).size, 14, 'as 14 famílias do livro');
  }
});

test('empresa_comum_nao_escreve_no_catalogo_pelo_banco', async () => {
  await withRollbackTenantTransaction(tenant, async (tx) => {
    const [, linhas] = await sequelize.query("UPDATE integration.providers SET display_name = 'invadido' WHERE code = 'signature-clicksign'", { transaction: tx });
    assert.equal(linhas.rowCount, 0, 'sem a marca de plataforma nenhuma linha do catálogo muda');
    await assert.rejects(
      sequelize.query("INSERT INTO integration.providers (code, display_name, domain, capabilities, supported_versions, criticality, sandbox_available) VALUES ('qa-m9-intruso', 'x', 'BANK', '[]', '[\"v1\"]', 'LOW', true)", { transaction: tx }),
      /row-level security/i
    );
  });
});

test('plataforma_edita_linha_semeada_sem_422_e_o_nome_vale_para_as_duas_empresas', async () => {
  await withRollbackTenantTransaction(tenant, async (tx) => {
    const editado = await providers.updateProvider('signature-clicksign', { displayName: 'QA-M9 Clicksign renomeado' }, ctx, tx);
    assert.equal(editado.displayName, 'QA-M9 Clicksign renomeado');
    const lido = await IntegrationProvider.findByPk('signature-clicksign', { transaction: tx });
    assert.equal(lido.displayName, 'QA-M9 Clicksign renomeado');
  });
  const original = await withRollbackTenantTransaction(outra, (tx) => IntegrationProvider.findByPk('signature-clicksign', { transaction: tx }));
  assert.notEqual(original.displayName, 'QA-M9 Clicksign renomeado', 'a transação foi desfeita');
});
