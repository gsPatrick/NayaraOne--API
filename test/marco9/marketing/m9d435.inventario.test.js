'use strict';

// M9-D435 — inventário das rotas do Marketing lido do Express (sem banco): as 10 rotas do livro com a permissão da tabela, as rotas inferidas I1 a I9 e nenhuma outra.
// Rotas necessárias a outras demandas do mesmo marco entram na terceira tabela da demanda (DI-D435-1), com dona e permissão.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allRoutes } = require('../_helpers/m9d852Rotas');

const norm = (p) => p.replace(/^\/v1(?=\/)/, '');
const isMarketing = (p) => /^\/(marketing|t\/|public\/properties)/.test(p);

/** Rotas de Marketing montadas na aplicação, uma vez cada ("MÉTODO caminho"). */
function mounted() {
  const set = new Set();
  for (const r of allRoutes()) {
    const path = norm(r.path);
    if (isMarketing(path)) for (const m of r.methods) set.add(`${m} ${path}`);
  }
  return set;
}

const BOOK = {
  'POST /marketing/content': 'marketing:content:write',
  'POST /marketing/content/:id/approve': 'marketing:content:approve',
  'POST /marketing/content/:id/schedule': 'marketing:content:publish',
  'POST /marketing/campaigns': 'marketing:campaign:manage',
  'POST /marketing/automations': 'marketing:automation:manage',
  'POST /marketing/automations/:id/publish': 'marketing:automation:publish',
  'POST /marketing/automations/:id/pause': 'marketing:automation:manage',
  'GET /marketing/publications': 'marketing:content:read',
  'GET /marketing/attribution': 'marketing:attribution:read',
  'POST /marketing/kill-switch': 'marketing:killswitch:manage',
};
const INFERRED = {
  'GET /marketing/content/:id': 'marketing:content:read', // I1
  'GET /marketing/campaigns/:id': 'marketing:campaign:manage', // I2
  'POST /marketing/templates': 'marketing:template:manage', // I3
  'GET /marketing/templates': 'marketing:content:read',
  'POST /marketing/templates/:id/publish': 'marketing:template:manage',
  'POST /marketing/publications/:id/cancel': 'marketing:content:publish', // I4
  'POST /marketing/tracking-links': 'marketing:campaign:manage', // I5
  'GET /t/:shortCode': null, // I6 (pública, assinatura do link)
  'POST /marketing/webhooks/:channel': null, // I7 (assinatura do provedor)
  'GET /public/properties/:publicId': null, // I8 (pública)
  'POST /marketing/media/:id/authorize': 'marketing:content:approve', // I9
};
/** DI-D435-1: rotas que outras demandas do marco exigem (impacto das ações destrutivas, sitemap e descadastro do e-mail). */
const FOR_OTHER_DEMANDS = {
  'GET /marketing/publications/:id/impact': 'marketing:content:publish', // I10, M9-D410 e M9-D852
  'POST /marketing/kill-switch/impact': 'marketing:killswitch:manage', // I11, M9-D425 e M9-D852
  'GET /marketing/seo/sitemap': 'marketing:content:read', // I12, M9-D427
  'POST /marketing/unsubscribe': null, // I13, M9-D429 (pública, token do e-mail)
};

test('as_10_rotas_existem_e_exigem_permissao', () => {
  const routes = mounted();
  const permissionOf = (key) => {
    const [method, path] = key.split(' ');
    const found = allRoutes().filter((r) => norm(r.path) === path && r.methods.includes(method));
    assert.ok(found.length >= 1, `${key} não está montada`);
    return found;
  };
  for (const [key, permission] of Object.entries(BOOK)) {
    assert.ok(routes.has(key), `${key} existe`);
    permissionOf(key);
    const { requiredPermissionOf } = require('../_helpers/m9d435Permissoes');
    assert.equal(requiredPermissionOf(key), permission, `${key} exige ${permission}`);
  }
  assert.equal(Object.keys(BOOK).length, 10);
});

test('rotas_inferidas_i1_a_i9_existem_e_nenhuma_outra', () => {
  const routes = mounted();
  const expected = new Set([...Object.keys(BOOK), ...Object.keys(INFERRED), ...Object.keys(FOR_OTHER_DEMANDS)]);
  const missing = [...expected].filter((k) => !routes.has(k));
  const extra = [...routes].filter((k) => !expected.has(k));
  assert.deepEqual(missing, [], 'rota prevista que não existe');
  assert.deepEqual(extra, [], 'rota de Marketing fora das tabelas da D435');
  const { requiredPermissionOf } = require('../_helpers/m9d435Permissoes');
  for (const [key, permission] of Object.entries({ ...INFERRED, ...FOR_OTHER_DEMANDS })) {
    if (permission) assert.equal(requiredPermissionOf(key), permission, `${key} exige ${permission}`);
  }
  assert.equal(Object.keys(INFERRED).length, 11, 'I1 a I9 (I3 tem 3 rotas)');
});

test('nenhuma_rota_de_exportacao_ou_segredo_no_marketing', () => {
  for (const key of mounted()) assert.ok(!/export|secret|token|password/i.test(key), key);
});
