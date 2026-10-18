'use strict';

// FIX DEFINITIVO (auditoria Marco 7 "reconf", 18/10/2026): três rodadas seguidas de auditoria
// acharam uma permissão DIFERENTE faltando no Painel do aprovador de Compras
// (construction:read → users:read → companies:read) — o conjunto do papel era ajustado por
// sintoma, uma permissão por rodada. Este teste trava o problema na raiz: chama por HTTP REAL
// todos os endpoints que app/painel/page.js consome (levantados do código do Front:
// listProperties, listPeople, listDuplicatePairs, listOpportunities, listRadars, /companies,
// /units, /users, /memberships), com um token contendo EXATAMENTE as permissões do seed
// scripts/seed-homo-aprovador-compras.js (importadas de lá — nunca uma cópia), e exige 200 em
// todos. Se o Painel ganhar uma chamada nova cuja permissão o papel não tem, este teste quebra
// ANTES de qualquer rodada de auditoria manual.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.PAINEL_APPROVER_HTTP_TEST_PORT || '21600';

const app = require('../app');
const { sequelize, getSeedTenant } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { PERMISSION_CODES } = require('../scripts/seed-homo-aprovador-compras');

let tenant;
let baseUrl;
let approverToken;

after(async () => {
  await sequelize.close();
  // Mesmo padrão dos demais *.httpRoutes.test.js: app.listen incondicional em app.js segura o
  // event loop pra sempre sem o exit explícito.
  process.exit(0);
});

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  approverToken = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['member'],
    permissions: PERMISSION_CODES,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

// Cada entrada é uma chamada que app/painel/page.js faz ao carregar (GET, leitura pura).
const PAINEL_ENDPOINTS = [
  '/properties',
  '/people',
  '/people/duplicates',
  '/opportunities',
  '/radar',
  '/companies',
  '/units',
  '/users',
  '/memberships',
];

for (const path of PAINEL_ENDPOINTS) {
  test(`Painel do aprovador (HTTP real): GET ${path} responde 200 com as permissões do seed`, async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${approverToken}` },
    });
    assert.equal(
      res.status,
      200,
      `GET ${path} devolveu ${res.status} — o Painel vai mostrar "Permissão ausente" pro aprovador. ` +
        'Adicione a permissão exigida pela rota ao PERMISSION_CODES do seed scripts/seed-homo-aprovador-compras.js.'
    );
  });
}
