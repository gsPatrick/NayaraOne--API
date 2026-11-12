'use strict';

// Verificação independente do Marco 9, rodada 7 (12/11/2026): a cada rodada outra rota dava 500 com uma forma de entrada nova. Este teste percorre
// TODAS as rotas de escrita do mapa de rotas (scripts/gerarMatrizPermissoes.js), com as formas da rodada 7 que não dependem do corpo de cada rota:
// corpo que não é objeto, JSON aninhado fundo, número infinito, e os nomes de campo mais comuns da API com o tipo ou o tamanho errado. Nenhuma
// resposta pode ser 5xx (fora o 503 de módulo desligado por parâmetro), nenhum pedido pode ficar sem resposta e nenhum pode passar de 2 s.
// HTTP real (login, JWT, tenant, RLS), perfil fictício com todas as permissões, a NAY ligada na empresa. Só em banco descartável ou no CI.

process.env.PORT = process.env.ENTRADA_GLOBAL_ROTAS_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const env = require('./marco9/_helpers/m9d230Env');
const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');
const { gerar } = require('../scripts/gerarMatrizPermissoes');

const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-entrada-rotas-${SUFIXO}@ci.nayaraone.test`;
const PARAMETROS = ['governanca.api.rate_limit.habilitado', 'ia.habilitada', 'ai.agents.enabled'];
let skipReason = null;
let A; let token;

function pedir(method, path, corpo, { semToken = false } = {}) {
  return new Promise((resolve) => {
    const h = { 'Content-Type': 'application/json', ...(semToken ? {} : { Authorization: `Bearer ${token}` }) };
    const buf = Buffer.from(corpo);
    h['Content-Length'] = buf.length;
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), method, path, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_e) { json = null; }
        resolve({ status: res.statusCode, code: json && json.error ? json.error.code : null, ms: Date.now() - t0 });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('sem resposta em 20 s')));
    req.on('error', (e) => resolve({ status: 0, code: e.message, ms: Date.now() - t0 }));
    req.write(buf);
    req.end();
  });
}

const fundo = (n) => `${'{"a":'.repeat(n)}1${'}'.repeat(n)}`;
const COMUNS = ['name', 'title', 'description', 'notes', 'status', 'type', 'code', 'email', 'reason', 'comment', 'value', 'amount', 'date', 'id',
  'personId', 'propertyId', 'opportunityId', 'companyId', 'userId', 'fileId', 'entryId', 'contractId', 'projectId', 'supplierId', 'itemId', 'caseId'];
const comTodos = (cru) => `{${COMUNS.map((c) => `"${c}":${cru}`).join(',')}}`;
const FORMAS = [
  ['lista', '[]'], ['texto', '"x"'], ['número', '1'], ['null', 'null'], ['aninhado 50000', fundo(50000)], ['campo aninhado 5000', `{"name":${fundo(5000)}}`],
  ['1e400', '{"amount":1e400,"value":-1e400}'], ['campos comuns com objeto', comTodos('{"x":1}')], ['campos comuns com lista', comTodos('[1,"a"]')],
  ['campos comuns com número', comTodos('123456789012')], ['campos comuns com booleano', comTodos('true')], ['campos comuns com texto de 5000', comTodos(JSON.stringify('x'.repeat(5000)))],
  ['campos comuns com data inválida', comTodos('"2026-13-45T99:99:99Z"')],
];
const PULAR = [/\/mfa\b/i, /\/auth\/(logout|switch|refresh)/, /\/users\/me\/(password|mfa)/];
const caminho = (p) => p.split('/').map((s) => (s.startsWith(':') ? (/key|code|slug|name|provider|type/i.test(s) ? 'x' : '00000000-0000-4000-8000-0000000000aa') : s)).join('/');

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  A = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await env.parametro(A, 'governanca.api.rate_limit.habilitado', false);
  await env.parametro(A, 'ia.habilitada', true);
  await env.parametro(A, 'ai.agents.enabled', '*');
  const ps = await Permission.findAll();
  const user = await User.create({ name: 'CI entrada rotas', email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI ENTRADA ROTAS ${SUFIXO}`, description: 'Perfil fictício do teste de todas as rotas (todas as permissões).', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId: user.id, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  await new Promise((s) => setTimeout(s, 300));
  for (let i = 0; i < 5 && !token; i += 1) {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: A.companyId }) });
    if (r.status === 200) token = (await r.json()).data.accessToken; else await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  assert.ok(token, 'login do usuário do teste');
});

after(async () => {
  if (A) await env.restaurar(A, PARAMETROS).catch(() => {});
  await env.sequelize.close().catch(() => {});
  process.exit(0);
});

test('todas as rotas de escrita: nenhuma forma da rodada 7 dá 5xx, fica sem resposta ou passa de 2 s', { timeout: 1800000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const todas = gerar().filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && !PULAR.some((re) => re.test(r.path)));
  const rotas = [...todas.filter((r) => !/\/settings/.test(r.path)), ...todas.filter((r) => /\/settings/.test(r.path))];
  assert.ok(rotas.length > 400, `o mapa de rotas tem as rotas de escrita (${rotas.length})`);
  const ruins = [];
  let total = 0;
  for (const r of rotas) {
    for (const [forma, corpo] of FORMAS) {
      const res = await pedir(r.method, caminho(r.path), corpo);
      total += 1;
      const desligado = res.status === 503 && /_DISABLED$|_NOT_CONFIGURED$/.test(String(res.code));
      if ((res.status >= 500 && !desligado) || res.status <= 0 || res.ms >= 2000) ruins.push(`${r.method} ${r.path} [${forma}] -> ${res.status} ${res.code || ''} (${res.ms} ms)`);
    }
  }
  console.log(`ENTRADA_GLOBAL_ROTAS ${rotas.length} rotas, ${total} pedidos, ${ruins.length} fora do esperado`);
  assert.deepEqual(ruins, []);
  const vivo = await pedir('GET', '/api/v1/people', '{}');
  assert.equal(vivo.status, 200, 'a API segue atendendo');
});
