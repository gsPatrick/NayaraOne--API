'use strict';

// Tentativas diretas na API, sem depender de botão oculto ou desabilitado: para CADA rota protegida por permissão
// (matriz gerada do código real), uma requisição sem token deve dar 401 e uma com token válido, mas SEM nenhuma
// permissão, deve dar 403 PERMISSION_DENIED com a permissão exigida. A permissão é checada antes do handler,
// então nenhuma dessas chamadas altera dado.

process.env.PORT = process.env.PERMISSION_MATRIX_TEST_PORT || '21611';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('../app');
const { gerar } = require('../scripts/gerarMatrizPermissoes');
const { signAccessToken } = require('../src/utils/jwt');
const { sequelize, getSeedTenant } = require('./testHelpers');

let baseUrl;
let tokenSemPermissao;
let rotas;

before(async () => {
  const tenant = await getSeedTenant();
  tokenSemPermissao = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['sem-permissao'], permissions: [] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}`;
  rotas = gerar().filter((r) => r.permissions.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 400));
});

after(async () => {
  await sequelize.close();
  // O servidor HTTP do app mantém o processo vivo; o atraso deixa o relatório do teste ser descarregado antes de sair.
  setTimeout(() => process.exit(0), 700);
});

const caminho = (p) => p.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

async function chamar(rota, token) {
  const resposta = await fetch(`${baseUrl}${caminho(rota.path)}`, {
    method: rota.method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: ['GET', 'HEAD', 'DELETE'].includes(rota.method) ? undefined : '{}',
  });
  let corpo = null;
  try { corpo = await resposta.json(); } catch { corpo = null; }
  return { status: resposta.status, corpo };
}

test('matriz: a API tem rotas protegidas por permissão', () => {
  assert.ok(rotas.length > 400, `esperava mais de 400 rotas protegidas, achei ${rotas.length}`);
});

test('toda rota protegida recusa chamada sem token (401)', async () => {
  const falhas = [];
  for (const rota of rotas) {
    const r = await chamar(rota, null);
    if (r.status !== 401) falhas.push(`${rota.method} ${rota.path} => ${r.status}`);
  }
  assert.deepEqual(falhas, [], `rotas que não responderam 401 sem token:\n${falhas.slice(0, 20).join('\n')}`);
});

test('toda rota protegida recusa token sem a permissão exigida (403 PERMISSION_DENIED com a permissão pedida)', async () => {
  const falhas = [];
  for (const rota of rotas) {
    const r = await chamar(rota, tokenSemPermissao);
    const pedida = r.corpo?.error?.details?.required ?? r.corpo?.details?.required;
    if (r.status !== 403) falhas.push(`${rota.method} ${rota.path} => ${r.status}`);
    else if (rota.permissions.length === 1 && pedida && pedida !== rota.permissions[0]) falhas.push(`${rota.method} ${rota.path} pediu ${pedida}, esperado ${rota.permissions[0]}`);
  }
  assert.deepEqual(falhas, [], `rotas com resposta diferente de 403 sem permissão:\n${falhas.slice(0, 20).join('\n')}`);
});
