'use strict';

// Entrada das rotas de mensagem pelo caminho HTTP real (login com senha, JWT, auth, tenant middleware e RLS). Verificação independente de
// 12/11/2026, rodada 5 (`Maturacao/fechamento-m3-m6/verificacao/m9-rodada5.md`): campo a campo, cada rodada achava outro campo que virava 500
// (actionKey fora do formato da CHECK, {"toString":1} em direction/channel/authorType/purpose/language/kind, kind herdado do protótipo, status
// sem validação). Regra (DI-M9R-11): o pedido inteiro de cada rota passa pelo esquema fechado da rota antes de qualquer outra regra; forma fora
// do esquema é 400 MESSAGE_VALIDATION com o nome do campo, e NENHUMA forma dá 500.
// Este arquivo percorre TODOS os campos de cada rota com as formas erradas (objeto, lista, número, booleano, {"toString":1}, {}, [], texto longo,
// texto fora do formato e nomes do protótipo como valor) e os nomes do protótipo como CAMPO. Onde o livro ou a demanda já dão outro código ao texto
// (telefone: 422 PHONE_INVALID, M9-D229; modelo e idioma: 422 TEMPLATE_NOT_APPROVED, M9-D230) ou o texto é válido (texto livre), o esperado é esse.
// GRAVA de verdade: só roda em banco descartável (DISPOSABLE_DB=1) ou no CI, depois do seed de dois tenants.

process.env.PORT = process.env.CRM_MESSAGES_SCHEMA_HTTP_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const env = require('./marco9/_helpers/m9d230Env');
const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');
const F = require('./helpers/mensagensFormas');
// A lista de canais aceita vem do código (a integração dos Marcos 3 a 6 acrescentou SITE, Guia M3 §12): o banco é compartilhado com outros arquivos que gravam interação pelo site.
const { CHANNELS } = require('../src/features/crm/messages.constants');

const PERMISSOES = ['crm:messages:read', 'crm:messages:create', 'crm:messages:update'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-msg-esquema-${SUFIXO}@ci.nayaraone.test`;
const MODELO_NAO_APROVADO = `nao_aprovado_${SUFIXO}`;

let skipReason = null;
let A; let userId; let token; let base; let pessoa; let foto; let manual;
const R = [];

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  A = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  const ps = await Permission.findAll({ where: { code: PERMISSOES } });
  assert.equal(ps.length, PERMISSOES.length);
  const user = await User.create({ name: 'CI esquema mensagens', email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  userId = user.id;
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI ESQUEMA MSG ${SUFIXO}`, description: 'Perfil fictício do teste do esquema das mensagens.', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  base = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((s) => setTimeout(s, 300));
  for (let i = 0; i < 5 && !token; i += 1) {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: A.companyId }) });
    if (r.status === 200) token = (await r.json()).data.accessToken; else await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  assert.ok(token, 'login do usuário do teste');
  await env.conectarComModelos(A, [env.modelo(MODELO_NAO_APROVADO, { approved: false, variables: 0 })]);
  pessoa = await env.pessoa(A);
  await env.abrirJanela(A, pessoa.id, 1);
  foto = await env.arquivo({ ...A, userId }); // enviado pelo próprio usuário do teste: ele pode ler o arquivo da mídia
  manual = await call('POST', '/messages', { channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: `manual esquema ${SUFIXO}` });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
});

after(async () => {
  if (A) { await env.pausar(A).catch(() => {}); await env.restaurar(A, ['integration.storage.default_provider']).catch(() => {}); }
  await env.sequelize.close().catch(() => {});
  process.exit(0);
});

/** Pedido HTTP; `corpo` em texto vai como está (para levar `"__proto__"` como campo próprio). */
async function call(method, caminho, corpo) {
  const body = corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
  const r = await fetch(base + caminho, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Registra o caso; `esperado` = { status, code?, campo? }. */
function conferir(rotulo, r, esperado) {
  const code = r.body && r.body.error ? r.body.error.code : null;
  const msg = r.body && r.body.error ? r.body.error.message : '';
  const ok = r.status === esperado.status && (!esperado.code || code === esperado.code) && (!esperado.campo || msg.includes(`"${esperado.campo}"`));
  R.push({ rotulo, status: r.status, code, ok, esperado });
}

const verificar = (t) => {
  const quinhentos = R.filter((x) => x.status >= 500);
  const falhas = R.filter((x) => !x.ok);
  t.diagnostic(`casos: ${R.length}; 500: ${quinhentos.length}; fora do esperado: ${falhas.length}`);
  assert.deepEqual(quinhentos.map((x) => `${x.rotulo} -> ${x.status}`), [], 'nenhuma forma de entrada dá 500');
  assert.deepEqual(falhas.map((x) => `${x.rotulo} -> ${x.status} ${x.code} (esperado ${x.esperado.status} ${x.esperado.code || ''})`), [], 'cada forma dá o esperado');
};

test('POST /messages: cada campo, em todas as formas erradas, dá 400 MESSAGE_VALIDATION com o nome do campo (nunca 500)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  R.length = 0;
  const corpo = { channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: `esquema ${SUFIXO}` };
  for (const [campo, regra] of Object.entries(F.CAMPOS_CRIAR)) {
    for (const [forma, valor] of Object.entries(F.FORMAS)) {
      conferir(`POST /messages ${campo}=${forma}`, await call('POST', '/messages', F.comCampo(corpo, campo, valor)), F.esperadoCriar(regra, campo, forma));
    }
  }
  for (const campo of F.DESCONHECIDOS_CRIAR) conferir(`POST /messages campo ${campo}`, await call('POST', '/messages', F.comCampo(corpo, campo, 'x')), F.E400(campo));
  conferir('POST /messages corpo lista', await call('POST', '/messages', '[]'), F.E400());
  conferir('POST /messages corpo texto (o leitor de JSON recusa antes)', await call('POST', '/messages', '"x"'), { status: 400, code: 'INVALID_JSON_BODY' });
  // os campos do servidor continuam descartados: autor e empresa da sessão
  const r = await call('POST', '/messages', { ...corpo, authorUserId: { toString: 1 }, groupId: [1], companyId: { id: 1 }, deliveryStatus: 'X'.repeat(40) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.authorUserId, r.body.data.companyId, r.body.data.deliveryStatus], [userId, A.companyId, null]);
  verificar(t);
  const [lixo] = await env.sql(A, "SELECT count(*)::int AS n FROM crm.messages WHERE company_id = :c AND (status IN ('[OBJECT OBJECT]', '', 'TRUE') OR channel NOT IN (:canais))", { c: A.companyId, canais: CHANNELS });
  assert.equal(lixo.n, 0, 'nenhum valor fora da lista gravado');
});

test('POST /messages/send: cada campo, nas três bases (modelo, texto, mídia), em todas as formas erradas, nunca dá 500', async (t) => {
  if (skipReason) return t.skip(skipReason);
  R.length = 0;
  const bases = {
    template: { kind: 'template', templateName: 'boas_vindas', personId: pessoa.id, to: pessoa.phone },
    text: { kind: 'text', text: 'esquema texto', personId: pessoa.id, to: pessoa.phone },
    media: { kind: 'media', mediaRef: foto.id, personId: pessoa.id, to: pessoa.phone },
  };
  for (const [nome, b] of Object.entries(bases)) conferir(`controle send ${nome}`, await call('POST', '/messages/send', b), { status: 202 });
  for (const [nome, campos] of Object.entries(F.CAMPOS_ENVIAR)) {
    for (const [campo, regra] of Object.entries(campos)) {
      for (const [forma, valor] of Object.entries(F.FORMAS)) {
        conferir(`POST /messages/send (${nome}) ${campo}=${forma}`, await call('POST', '/messages/send', F.comCampo(bases[nome], campo, valor)), F.esperadoEnviar(regra, campo, forma));
      }
    }
  }
  for (const campo of F.DESCONHECIDOS_ENVIAR) conferir(`POST /messages/send campo ${campo}`, await call('POST', '/messages/send', F.comCampo(bases.template, campo, 'x')), F.E400(campo));
  verificar(t);
});

test('kind em lista não fura a regra do modelo aprovado (M9-D230 3.1): 400 para a lista e 422 TEMPLATE_NOT_APPROVED para o modelo não aprovado, pela rota e pelo serviço', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const contar = async () => (await env.sql(A, "SELECT count(*)::int AS n FROM integration.dispatches WHERE company_id = :c AND operation = 'sendTemplate' AND payload_snapshot::text LIKE :m", { c: A.companyId, m: `%${MODELO_NAO_APROVADO}%` }))[0].n;
  const antes = await contar();
  const pedido = (kind, extra = {}) => ({ kind, templateName: MODELO_NAO_APROVADO, personId: pessoa.id, to: pessoa.phone, ...extra });
  // rota HTTP
  for (const kind of [['template'], ['text'], 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'TEMPLATE']) {
    for (const extra of [{}, { caption: 'legenda' }]) {
      const r = await call('POST', '/messages/send', pedido(kind, extra));
      assert.equal(r.status, 400, `kind=${JSON.stringify(kind)} ${JSON.stringify(extra)}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'MESSAGE_VALIDATION');
      assert.match(r.body.error.message, /"kind"/);
    }
  }
  const http422 = await call('POST', '/messages/send', pedido('template', { caption: 'legenda' }));
  assert.equal(http422.status, 422, JSON.stringify(http422.body));
  assert.equal(http422.body.error.code, 'INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED');
  // serviço (o mesmo caminho para quem chamar sem passar pela rota)
  for (const kind of [['template'], ['text'], 'toString', 'constructor', '__proto__', 'hasOwnProperty', { toString: 1 }]) {
    await assert.rejects(env.enviarMensagem(A, pedido(kind, { caption: 'legenda', semJanela: true })), (e) => e.statusCode === 400 && e.code === 'MESSAGE_VALIDATION' && /"kind"/.test(e.message), `serviço kind=${JSON.stringify(kind)}`);
  }
  await assert.rejects(env.enviarMensagem(A, pedido('template')), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED');
  await assert.rejects(env.enviarMensagem(A, pedido('template', { language: { toString: 1 } })), (e) => e.statusCode === 400 && /"language"/.test(e.message));
  assert.equal(await contar(), antes, 'nenhum envio do modelo não aprovado entrou na fila');
});

test('PATCH /messages/:id/status, send-alternate, refresh-status, GET por id e filtros do GET /messages: toda forma errada é 400, nunca 500', async (t) => {
  if (skipReason) return t.skip(skipReason);
  R.length = 0;
  const id = manual.body.data.id;
  for (const [forma, valor] of Object.entries({ ...F.FORMAS, minusculaForaDaLista: 'lida', vazio: '', nulo: null })) {
    conferir(`PATCH status=${forma}`, await call('PATCH', `/messages/${id}/status`, { status: valor }), F.E400('status'));
  }
  conferir('PATCH sem status', await call('PATCH', `/messages/${id}/status`, {}), F.E400('status'));
  for (const campo of F.PROTO_CAMPOS.concat(['deliveryStatus', 'body'])) conferir(`PATCH campo ${campo}`, await call('PATCH', `/messages/${id}/status`, F.comCampo({ status: 'READ' }, campo, 'x')), F.E400(campo));
  const [{ status: depois }] = await env.sql(A, 'SELECT status FROM crm.messages WHERE id = :id', { id });
  assert.equal(depois, 'RECEIVED', 'nenhuma forma errada mudou o status');
  for (const caminho of F.IDS_DE_CAMINHO) {
    conferir(`PATCH /messages/${caminho.slice(0, 20)}/status`, await call('PATCH', `/messages/${caminho}/status`, { status: 'READ' }), F.E400('id'));
    conferir(`GET /messages/${caminho.slice(0, 20)}`, await call('GET', `/messages/${caminho}`), F.E400('id'));
    for (const rota of ['send-alternate', 'refresh-status']) conferir(`POST /messages/${caminho.slice(0, 20)}/${rota}`, await call('POST', `/messages/${caminho}/${rota}`), F.E400('id'));
  }
  for (const rota of ['send-alternate', 'refresh-status']) {
    for (const campo of F.PROTO_CAMPOS.concat(['status', 'kind'])) conferir(`POST ${rota} campo ${campo}`, await call('POST', `/messages/${id}/${rota}`, F.comCampo({}, campo, 'x')), F.E400(campo));
    conferir(`POST ${rota} corpo lista`, await call('POST', `/messages/${id}/${rota}`, '[]'), F.E400());
    conferir(`POST ${rota} sem corpo (controle: a regra da rota responde)`, await call('POST', `/messages/${id}/${rota}`), { status: 409 });
  }
  for (const [q, campo] of F.consultas(pessoa.id)) conferir(`GET /messages?${q.slice(0, 60)}`, await call('GET', `/messages?${q}`), F.E400(campo));
  for (const q of ['__proto__[a]=1', '__proto__=1']) conferir(`GET /messages?${q} (o parser descarta)`, await call('GET', `/messages?${q}`), { status: 200 });
  conferir('PATCH status=read (controle)', await call('PATCH', `/messages/${id}/status`, { status: 'read' }), { status: 200 });
  conferir(`GET /messages?personId=<uuid> (controle)`, await call('GET', `/messages?personId=${pessoa.id}`), { status: 200 });
  verificar(t);
});
