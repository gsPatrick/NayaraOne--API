'use strict';

// Trava as permissões do aprovador de Compras contra TODAS as telas do menu dele, não só o
// Painel. Histórico: cada rodada de auditoria achava uma permissão diferente faltando (Painel:
// construction:read → users:read → companies:read; depois Compras > Seguros: legal:read). Aqui,
// cada tela do menu (Painel, Estoque e submenus, Compras e submenus) lista os GET que ela faz ao
// abrir — levantados do código do Front (NayaraOne--FRONT/app/painel/...) — e o teste chama cada
// um por HTTP real com um token de EXATAMENTE as permissões do seed (importadas de lá, nunca uma
// cópia), exigindo 200. Tela nova ou chamada nova sem a permissão no papel quebra aqui antes de
// qualquer rodada manual.
//
// Também trava o menor privilégio (auditoria Marco 7 "final2", 18/10/2026): o aprovador não lê
// empresas nem vínculos, e a lista de usuários que ele vê não traz e-mail.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.APPROVER_SCREENS_HTTP_TEST_PORT || '21600';

const app = require('../app');
const { sequelize, getSeedTenant } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { PERMISSION_CODES } = require('../scripts/seed-homo-aprovador-compras');

let tenant;
let baseUrl;
let approverToken;
let adminLikeToken;

after(async () => {
  await sequelize.close();
  // Mesmo padrão dos demais testes HTTP: app.listen incondicional em app.js segura o event loop.
  process.exit(0);
});

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['member'] };
  approverToken = signAccessToken({ ...claims, permissions: PERMISSION_CODES });
  adminLikeToken = signAccessToken({ ...claims, permissions: ['users:read', 'users:update'] });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

// GETs disparados ao abrir cada tela. Seções que a tela só carrega com uma permissão que o
// aprovador não tem (ex.: abas administrativas do Painel, configuração de lead time das
// Sugestões) ficam de fora — o Front não as chama para ele.
const SCREENS = {
  'Painel (abas que o aprovador vê: Visão geral e Contatos)': ['/people', '/people/duplicates'],
  'Estoque > Itens': ['/inventory/items', '/inventory/locations', '/construction/projects'],
  'Estoque > Movimentos': ['/inventory/items', '/inventory/locations', '/inventory/movements', '/people'],
  'Estoque > Recebimentos (NF)': ['/inventory/receipts', '/inventory/items', '/inventory/locations', '/people'],
  'Estoque > Requisições': ['/inventory/requisitions', '/inventory/items', '/inventory/locations', '/construction/projects'],
  'Estoque > Patrimônio, Ferramentas & QR': ['/assets', '/inventory/locations', '/users', '/tool-loans?status=OPEN', '/tool-loans?status=OVERDUE'],
  'Estoque > Manutenção': ['/maintenance-orders', '/assets', '/users'],
  'Estoque > Perdas & Extravios': ['/inventory/loss-cases', '/inventory/items', '/inventory/locations', '/assets', '/inventory/nay/loss-case-anomalies', '/people'],
  'Estoque > Inventário físico': ['/inventory/counts', '/inventory/locations'],
  'Estoque > Sugestões da NAY': ['/inventory/nay/purchase-suggestions'],
  'Compras > Requisições de compra': ['/procurement/purchase-requests', '/inventory/items', '/construction/projects', '/people'],
  'Compras > Pedidos de compra': ['/procurement/purchase-orders', '/procurement/discrepancies', '/inventory/locations'],
  'Compras > Fornecedores': ['/procurement/supplier-qualifications', '/procurement/purchase-orders', '/people'],
  'Compras > Seguros': ['/procurement/insurance-policies'],
  // Também no menu do aprovador: Contatos (people:read, que ele tem para o seletor de pessoa) e
  // Obras (construction:read, que ele tem para obra/etapa nas requisições). Nas telas de Obras a
  // lista de imóveis é opcional (só nomeia o imóvel) e não entra aqui.
  Contatos: ['/people', '/people/duplicates'],
  'Obras > Visão geral': ['/construction/projects', '/construction/maintenance-cases', '/users'],
  'Obras > Obras': ['/construction/projects', '/users'],
  'Obras > Pós-obra': ['/construction/maintenance-cases', '/construction/projects', '/people', '/users'],
  'Obras > Configurações': ['/construction/settings/sla-rule'],
};

async function get(path, token) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

for (const [screen, paths] of Object.entries(SCREENS)) {
  test(`Aprovador (HTTP real): ${screen} abre sem erro de permissão`, async () => {
    for (const path of paths) {
      const { status, body } = await get(path, approverToken);
      assert.equal(
        status,
        200,
        `${screen}: GET ${path} devolveu ${status} (${body?.error?.code || ''}) — a tela vai mostrar "Permissão ausente" ` +
          'para o aprovador. Adicione a permissão ao PERMISSION_CODES de scripts/seed-homo-aprovador-compras.js ' +
          'ou faça a tela não depender dessa chamada.'
      );
    }
  });
}

test('Aprovador: menor privilégio — não lê empresas, unidades, vínculos, contratos nem imóveis', async () => {
  for (const path of ['/companies', '/units', '/memberships', '/legal/contracts', '/properties']) {
    const { status } = await get(path, approverToken);
    assert.equal(status, 403, `GET ${path} deveria ser negado ao aprovador`);
  }
});

test('Aprovador: lista de usuários traz só nome e status (sem e-mail); quem administra usuários vê o e-mail', async () => {
  const approverView = await get('/users', approverToken);
  assert.equal(approverView.status, 200);
  assert.ok(Array.isArray(approverView.body.data));
  for (const user of approverView.body.data) {
    assert.deepEqual(Object.keys(user).sort(), ['id', 'name', 'status'], 'sem e-mail nem outro dado de cadastro');
  }

  const adminView = await get('/users', adminLikeToken);
  assert.equal(adminView.status, 200);
  assert.ok(adminView.body.data.some((u) => typeof u.email === 'string' && u.email.includes('@')), 'quem tem users:update vê o e-mail');
  assert.ok(
    adminView.body.data.length >= approverView.body.data.length,
    'a lista restrita é um subconjunto (só usuários com vínculo na empresa da sessão)'
  );
});
