'use strict';

// M9-D004 — rotas /v1/ai/agents: permissões, chave geral, ciclo criar > homologar > ativar e isolamento entre empresas.
// Só roda no cluster descartável (login real dos usuários do seed de dois tenants; nunca chama MFA nem forja token).

process.env.PORT = process.env.M9D004_HTTP_TEST_PORT || '21704';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = DISPOSABLE ? false : 'precisa do cluster descartável (node scripts/withDisposableDb.js)';
// Código e chave de idempotência únicos por execução: o teste se repete no mesmo banco sem cair em replay (200).
const RUN_ID = require('node:crypto').randomBytes(4).toString('hex').toUpperCase();
const CODE = `QA_M9_HTTP_${RUN_ID}`;
const IDEM_KEY = `qa-m9-http-${RUN_ID}`;
const tokens = {};
let baseUrl;
let appLoaded = false;

async function admin(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

async function grant(roleName, codes) {
  await admin(
    `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
     SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
      WHERE r.name = $1 AND p.code = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
    [roleName, codes]
  );
}

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  if (!DISPOSABLE) return;
  const { emailFor } = require('../../scripts/seed-ci-two-tenants');
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  // GESTOR cria e ativa (ai:admin), CHECKER homologa (ai:evaluate), LEITURA só consulta (ai:use). Nenhuma delas chama MFA.
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  await grant('CI CHECKER', ['ai:evaluate', 'ai:use', 'ai:admin']) // com ai:admin também, para provar que quem homologou não ativa;
  await grant('CI LEITURA', ['ai:use']);
  require('../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'checker'], ['A', 'leitura'], ['B', 'gestor']]) {
    let res; let data;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(tenant, profile), password }) });
      data = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}`);
    tokens[`${tenant}:${profile}`] = data.data.accessToken;
  }
});

after(async () => {
  if (!appLoaded) return;
  // Devolve as configurações ao padrão para não afetar os outros arquivos de teste que usam as mesmas empresas.
  for (const tenant of ['A', 'B']) {
    await call('PUT', '/settings/ia.habilitada', tokens[`${tenant}:gestor`], { value: false });
  }
  await call('PUT', '/settings/ia.agente.avaliacao_verde_obrigatoria', tokens['A:gestor'], { value: true });
  setTimeout(() => process.exit(0), 300);
});

const NOVA = {
  purpose: 'Agente de teste do ciclo HTTP.', systemPolicy: 'Cite as fontes.', modelPolicy: { capability: 'chat' }, dataScopes: ['crm.opportunities'],
  limits: {}, criticality: 'NON_CRITICAL', tools: [{ toolName: 'crm.buscar', permissionCode: 'ai:read', riskLevel: 'LOW' }],
};

test('m9d004_http_chave_geral_desligada_responde_503', { skip: SKIP }, async () => {
  const r = await call('GET', '/ai/agents', tokens['A:gestor']);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'AI_FEATURE_DISABLED');
});

test('m9d004_http_ciclo_criar_homologar_ativar_e_listar', { skip: SKIP }, async () => {
  for (const tenant of ['A', 'B']) {
    const on = await call('PUT', '/settings/ia.habilitada', tokens[`${tenant}:gestor`], { value: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
  }
  const off = await call('PUT', '/settings/ia.agente.avaliacao_verde_obrigatoria', tokens['A:gestor'], { value: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));

  const criada = await call('POST', `/ai/agents/${CODE}/versions`, tokens['A:gestor'], NOVA, { 'Idempotency-Key': IDEM_KEY });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  assert.equal(criada.body.data.status, 'DRAFT');
  assert.equal(criada.body.data.version, 1);
  const repetida = await call('POST', `/ai/agents/${CODE}/versions`, tokens['A:gestor'], NOVA, { 'Idempotency-Key': IDEM_KEY });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.body.data.id, criada.body.data.id);

  // Ativar sem homologar: 409.
  const cedo = await call('POST', `/ai/agents/${CODE}/versions/1/activate`, tokens['A:gestor']);
  assert.equal(cedo.status, 409); assert.equal(cedo.body.error.code, 'AI_AGENT_NOT_HOMOLOGATED');
  // Quem não tem ai:evaluate não homologa.
  const semPerm = await call('POST', `/ai/agents/${CODE}/versions/1/homologate`, tokens['A:gestor']);
  assert.equal(semPerm.status, 403); assert.equal(semPerm.body.error.code, 'PERMISSION_DENIED');
  const homolog = await call('POST', `/ai/agents/${CODE}/versions/1/homologate`, tokens['A:checker'], { note: 'revisado' });
  assert.equal(homolog.status, 200, JSON.stringify(homolog.body));
  assert.equal(homolog.body.data.status, 'HOMOLOGATED');
  // Quem homologou não ativa (segregação).
  const mesmo = await call('POST', `/ai/agents/${CODE}/versions/1/activate`, tokens['A:checker']);
  assert.equal(mesmo.status, 403); assert.equal(mesmo.body.error.code, 'AI_AGENT_SEGREGATION');
  const ativa = await call('PUT', `/ai/agents/${CODE}/versions/1/activate`, tokens['A:gestor']);
  assert.equal(ativa.status, 200, JSON.stringify(ativa.body));
  assert.equal(ativa.body.data.status, 'ACTIVE');

  const editar = await call('PATCH', `/ai/agents/${CODE}/versions/1`, tokens['A:gestor'], { purpose: 'Outra finalidade.' });
  assert.equal(editar.status, 409); assert.equal(editar.body.error.code, 'AI_AGENT_IMMUTABLE');

  // Versão 2 copiando a 1; v2 ativada aposenta a v1.
  const v2 = await call('POST', `/ai/agents/${CODE}/versions`, tokens['A:gestor'], { purpose: 'Finalidade da versão 2.' });
  assert.equal(v2.status, 201); assert.equal(v2.body.data.version, 2);
  assert.equal((await call('POST', `/ai/agents/${CODE}/versions/2/homologate`, tokens['A:checker'])).status, 200);
  assert.equal((await call('POST', `/ai/agents/${CODE}/versions/2/activate`, tokens['A:gestor'])).status, 200);
  const lista = await call('GET', `/ai/agents/${CODE}/versions`, tokens['A:gestor']);
  assert.deepEqual(lista.body.data.map((v) => [v.version, v.status]), [[2, 'ACTIVE'], [1, 'RETIRED']]);

  // ai:use lista só os ativos e não vê a política do agente.
  const ativos = await call('GET', '/ai/agents', tokens['A:leitura']);
  assert.equal(ativos.status, 200);
  const meu = ativos.body.data.find((a) => a.code === CODE);
  assert.ok(meu); assert.equal(meu.version, 2); assert.equal(meu.systemPolicy, undefined);
  assert.equal((await call('GET', `/ai/agents/${CODE}/versions`, tokens['A:leitura'])).status, 403);
});

test('m9d004_http_update_direto_na_versao_ativa_e_negado_pelo_banco', { skip: SKIP }, async () => {
  // Nem o superusuário do cluster contorna: o gatilho vale para qualquer papel.
  await assert.rejects(
    () => admin("UPDATE ai.agents SET purpose = 'adulterado por SQL' WHERE code = $1 AND status = 'ACTIVE'", [CODE]),
    (err) => { console.log(`# SQL negado pelo gatilho: ${err.message}`); return /AI_AGENT_IMMUTABLE/.test(err.message); }
  );
});

test('m9d004_http_empresa_b_nao_ve_o_agente_da_a_e_o_padrao_do_sistema_nao_se_altera', { skip: SKIP }, async () => {
  const b = await call('GET', `/ai/agents/${CODE}/versions/1`, tokens['B:gestor']);
  assert.equal(b.status, 404); assert.equal(b.body.error.code, 'AI_AGENT_NOT_FOUND');
  assert.deepEqual((await call('GET', `/ai/agents/${CODE}/versions`, tokens['B:gestor'])).body.data, []);
  const sistema = await call('PATCH', '/ai/agents/NAY_COMERCIAL/versions/1', tokens['B:gestor'], { purpose: 'Adulterada' });
  assert.equal(sistema.status, 409); assert.equal(sistema.body.error.code, 'AI_AGENT_SYSTEM_DEFAULT');
  const leitura = await call('GET', '/ai/agents/NAY_COMERCIAL/versions/1', tokens['B:gestor']);
  assert.equal(leitura.status, 200); assert.equal(leitura.body.data.status, 'DRAFT'); assert.equal(leitura.body.data.scope, 'SYSTEM');
});

test('m9d004_http_validacoes_devolvem_400_em_portugues', { skip: SKIP }, async () => {
  const semPurpose = await call('POST', '/ai/agents/QA_SEM_PURPOSE/versions', tokens['A:gestor'], { criticality: 'NON_CRITICAL' });
  assert.equal(semPurpose.status, 400); assert.equal(semPurpose.body.error.code, 'AI_AGENT_INVALID');
  const alta = await call('POST', '/ai/agents/QA_ALTA/versions', tokens['A:gestor'], { ...NOVA, tools: [{ toolName: 'fin.pagar', permissionCode: 'ai:read', riskLevel: 'HIGH' }] });
  assert.equal(alta.status, 400); assert.equal(alta.body.error.code, 'AI_AGENT_TOOL_INVALID');
  assert.match(alta.body.error.message, /Ferramenta de risco alto exige aprovação humana\./);
  const limite = await call('PUT', '/settings/ia.agente.max_tokens_run', tokens['A:gestor'], { value: 8 });
  assert.equal(limite.status, 400);
});
