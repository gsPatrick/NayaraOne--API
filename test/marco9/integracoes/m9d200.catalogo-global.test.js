'use strict';

// Marco 9, M9-D200 (reabertura M1) — o catálogo GLOBAL de fornecedores só é escrito com a permissão de plataforma (HTTP real, duas empresas).
// Roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D200_CATALOGO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');

const base = '/admin/integrations/registry/providers';
const codigo = `qa-m9-d200-${Date.now().toString(36)}`;
let tenants;
let admin;
let adminB;
let plataforma;
let chamar;

before(async () => {
  tenants = await env.carregarTenants();
  assert.ok(tenants.outro, 'o seed precisa ter a empresa B');
  admin = env.tokenDe(tenants.tenant, ['integration:read', 'integration:manage']);
  adminB = env.tokenDe(tenants.outro, ['integration:read', 'integration:manage']);
  plataforma = env.tokenDe(tenants.tenant, ['integration:read', 'integration:platform']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await chamar(plataforma, 'PATCH', `${base}/${codigo}`, { status: 'DISABLED' });
  await env.sequelize.close();
  process.exit(0);
});

const novo = () => ({ code: codigo, displayName: 'QA-M9 fornecedor', domain: 'BANK', capabilities: [], supportedVersions: ['v1'], criticality: 'LOW', sandboxAvailable: true });

test('catalogo_global_admin_de_empresa_nao_cria_nem_edita', async () => {
  const criar = await chamar(admin, 'POST', base, novo());
  assert.equal(criar.status, 403, JSON.stringify(criar.corpo));
  assert.equal(criar.corpo.error?.code ?? criar.corpo.code, 'PERMISSION_DENIED');
  const editar = await chamar(admin, 'PATCH', `${base}/signature-clicksign`, { status: 'DISABLED' });
  assert.equal(editar.status, 403);
  for (const token of [admin, adminB]) {
    const lista = await chamar(token, 'GET', base);
    assert.equal(lista.status, 200);
    assert.ok(!JSON.stringify(lista.corpo).includes(codigo), 'nada gravado pela empresa comum');
  }
});

test('catalogo_global_plataforma_cria_edita_e_as_duas_empresas_enxergam', async () => {
  const criar = await chamar(plataforma, 'POST', base, novo());
  assert.equal(criar.status, 201, JSON.stringify(criar.corpo));
  const editar = await chamar(plataforma, 'PATCH', `${base}/${codigo}`, { displayName: 'QA-M9 renomeado' });
  assert.equal(editar.status, 200, JSON.stringify(editar.corpo));
  assert.ok(JSON.stringify(editar.corpo).includes('QA-M9 renomeado'));
  for (const token of [admin, adminB]) {
    const lista = await chamar(token, 'GET', base);
    assert.ok(JSON.stringify(lista.corpo).includes('QA-M9 renomeado'), 'catálogo global: as duas empresas leem');
  }
  const desativar = await chamar(plataforma, 'PATCH', `${base}/${codigo}`, { status: 'DISABLED' });
  assert.equal(desativar.status, 200);
  assert.ok(JSON.stringify(desativar.corpo).includes('DISABLED'));
});

test('catalogo_global_editar_fornecedor_inexistente_da_422', async () => {
  const r = await chamar(plataforma, 'PATCH', `${base}/qa-m9-nao-existe`, { status: 'DISABLED' });
  assert.equal(r.status, 422);
  assert.equal(r.corpo.error?.code ?? r.corpo.code, 'INTEGRATION_PROVIDER_UNKNOWN');
});

test('catalogo_global_permissao_de_plataforma_nao_vai_para_nenhum_papel_de_empresa', async () => {
  const linhas = await env.sequelize.query(
    `SELECT count(*)::int AS n FROM core.permissions p JOIN core.role_permissions rp ON rp.permission_id = p.id WHERE p.code = 'integration:platform'`,
    { type: 'SELECT' }
  ).catch(() => null);
  const existe = await env.sequelize.query(`SELECT 1 FROM core.permissions WHERE code = 'integration:platform'`, { type: 'SELECT' });
  assert.equal(existe.length, 1, 'a permissão existe');
  if (linhas) assert.equal(linhas[0].n, 0, 'nenhum papel a recebe por padrão');
});
