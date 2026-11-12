'use strict';

// Entrada das rotas de mensagem pelo caminho HTTP real (login, JWT, auth, tenant middleware e RLS), verificação independente do Marco 9, rodada 6
// (`Maturacao/fechamento-m3-m6/verificacao/m9-rodada6.md`): as formas que o teste da rodada 5 não percorria e que davam 500 ou travavam a API.
//  1. corpo que não é JSON utilizável (charset, compressão quebrada ou não aceita) -> 415/400 (DI-M9R-14), nas 5 rotas de escrita e numa rota de fora;
//  2. escape % malformado no id do caminho -> 400 INVALID_ID_FORMAT, nas 4 rotas por id e numa rota de fora;
//  3. caractere nulo ou metade solta de par sub-rogado em text, caption, templateVars, body e na consulta -> 400, nada gravado nem enfileirado (DI-M9R-15);
//  4. texto livre acima do limite do canal -> 400 MESSAGE_VALIDATION; o limite é parâmetro da empresa; 20 MB sem espaço respondem em menos de 2 s (DI-M9R-16/17);
//  5. consulta nas rotas sem filtro -> 400 (o esquema fecha a consulta como o comentário dizia).
// Toda resposta é medida: nenhuma passa de 2 s. GRAVA de verdade: só em banco descartável (DISPOSABLE_DB=1) ou no CI, depois do seed de dois tenants.

process.env.PORT = process.env.CRM_MESSAGES_ROBUSTA_HTTP_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const bcrypt = require('bcryptjs');
const env = require('./marco9/_helpers/m9d230Env');
const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

const PERMISSOES = ['crm:messages:read', 'crm:messages:create', 'crm:messages:update', 'people:read'];
const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-msg-robusta-${SUFIXO}@ci.nayaraone.test`;
const UMA_VAR = `uma_var_robusta_${SUFIXO}`;
const LIMITES = ['integration.whatsapp.max_text_chars', 'integration.whatsapp.max_caption_chars', 'integration.whatsapp.max_template_var_chars', 'integration.messaging.record_body_max_chars'];

let skipReason = null;
let A; let token; let pessoa; let foto; let manual; let enviada;
const TEMPOS = [];

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  A = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  const ps = await Permission.findAll({ where: { code: PERMISSOES } });
  assert.equal(ps.length, PERMISSOES.length);
  const user = await User.create({ name: 'CI entrada robusta', email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI ROBUSTA ${SUFIXO}`, description: 'Perfil fictício do teste da entrada robusta.', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId: user.id, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  await new Promise((s) => setTimeout(s, 300));
  for (let i = 0; i < 5 && !token; i += 1) {
    const r = await pedir('POST', '/auth/login', { corpo: JSON.stringify({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: A.companyId }), semToken: true });
    if (r.status === 200) token = r.json.data.accessToken; else await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  assert.ok(token, 'login do usuário do teste');
  await env.conectarComModelos(A, [env.modelo(UMA_VAR, { variables: 1 })]);
  pessoa = await env.pessoa(A);
  await env.abrirJanela(A, pessoa.id, 1);
  foto = await env.arquivo({ ...A, userId: user.id });
  manual = await pedir('POST', '/messages', { corpo: JSON.stringify({ channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: `robusta ${SUFIXO}` }) });
  assert.equal(manual.status, 201, JSON.stringify(manual.json));
  enviada = await pedir('POST', '/messages/send', { corpo: JSON.stringify({ kind: 'text', text: `robusta env ${SUFIXO}`, personId: pessoa.id, to: pessoa.phone }) });
  assert.equal(enviada.status, 202, JSON.stringify(enviada.json));
});

after(async () => {
  if (A) { await env.restaurar(A, [...LIMITES, 'integration.storage.default_provider']).catch(() => {}); await env.pausar(A).catch(() => {}); }
  await env.sequelize.close().catch(() => {});
  process.exit(0);
});

/** Pedido HTTP cru (cabeçalhos e bytes como vierem), medido. `caminho` sem o prefixo /api/v1. */
function pedir(method, caminho, { headers = {}, corpo, semToken = false } = {}) {
  return new Promise((resolve) => {
    const h = { 'Content-Type': 'application/json', ...(semToken ? {} : { Authorization: `Bearer ${token}` }), ...headers };
    const buf = corpo === undefined ? null : Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo);
    if (buf) h['Content-Length'] = buf.length;
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), method, path: `/api/v1${caminho}`, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const ms = Date.now() - t0;
        TEMPOS.push({ rotulo: `${method} ${caminho.slice(0, 60)}`, ms });
        let json = null; try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_e) { json = null; }
        resolve({ status: res.statusCode, json, ms });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, erro: e.code }));
    if (buf) req.write(buf);
    req.end();
  });
}
const codigo = (r) => (r.json && r.json.error ? r.json.error.code : null);
const contarFila = async () => (await env.sql(A, 'SELECT count(*)::int AS n FROM integration.dispatches WHERE company_id = :c', { c: A.companyId }))[0].n;
const contarMensagens = async () => (await env.sql(A, 'SELECT count(*)::int AS n FROM crm.messages WHERE company_id = :c', { c: A.companyId }))[0].n;

const rotasDeEscrita = () => [
  ['POST', '/messages', { channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: 'r6' }],
  ['POST', '/messages/send', { kind: 'template', templateName: 'boas_vindas', personId: pessoa.id, to: pessoa.phone }],
  ['PATCH', `/messages/${manual.json.data.id}/status`, { status: 'READ' }],
  ['POST', `/messages/${manual.json.data.id}/send-alternate`, {}],
  ['POST', `/messages/${enviada.json.data.messageId}/refresh-status`, {}],
  ['POST', '/people', { legalName: 'r6' }], // rota de fora das mensagens: o leitor do corpo é o mesmo para a API inteira
];

test('1. corpo que não é JSON utilizável: 415 para charset ou compressão não aceitos, 400 para corpo comprimido quebrado, em todas as rotas de escrita', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const fora = [];
  for (const [m, caminho, valido] of rotasDeEscrita()) {
    const json = JSON.stringify(valido);
    const casos = [
      ['charset latin1', { 'Content-Type': 'application/json; charset=latin1' }, json, 415, 'REQUEST_BODY_CHARSET_UNSUPPORTED'],
      ['charset inexistente', { 'Content-Type': 'application/json; charset=nao-existe' }, json, 415, 'REQUEST_BODY_CHARSET_UNSUPPORTED'],
      ['gzip quebrado', { 'Content-Encoding': 'gzip' }, Buffer.from('isto não é gzip'), 400, 'REQUEST_BODY_DECOMPRESSION_FAILED'],
      ['deflate quebrado', { 'Content-Encoding': 'deflate' }, Buffer.from('isto não é deflate'), 400, 'REQUEST_BODY_DECOMPRESSION_FAILED'],
      ['Content-Encoding br', { 'Content-Encoding': 'br' }, zlib.brotliCompressSync(json), 415, 'REQUEST_BODY_ENCODING_UNSUPPORTED'],
      ['Content-Encoding desconhecido', { 'Content-Encoding': 'x-nada' }, json, 415, 'REQUEST_BODY_ENCODING_UNSUPPORTED'],
    ];
    for (const [nome, headers, corpo, status, code] of casos) {
      const r = await pedir(m, caminho, { headers, corpo });
      if (r.status !== status || codigo(r) !== code) fora.push(`${m} ${caminho} ${nome}: ${r.status} ${codigo(r)} (esperado ${status} ${code})`);
    }
  }
  assert.deepEqual(fora, []);
  // controle: o mesmo corpo em gzip válido é lido (a regra da rota responde)
  const gz = await pedir('POST', '/messages', { headers: { 'Content-Encoding': 'gzip' }, corpo: zlib.gzipSync(JSON.stringify({ channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: 'r6 gzip' })) });
  assert.equal(gz.status, 201, JSON.stringify(gz.json));
});

test('2. escape % malformado no id do caminho: 400 INVALID_ID_FORMAT nas rotas por id (e numa rota de fora), nunca 500', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const fora = [];
  for (const c of ['%E0%A4%A', '%', '%ZZ', '%C0%AF', '%ED%A0%80']) {
    for (const [m, caminho, corpo] of [['GET', `/messages/${c}`], ['PATCH', `/messages/${c}/status`, '{"status":"READ"}'], ['POST', `/messages/${c}/send-alternate`], ['POST', `/messages/${c}/refresh-status`], ['GET', `/people/${c}`]]) {
      const r = await pedir(m, caminho, { corpo });
      if (r.status !== 400 || codigo(r) !== 'INVALID_ID_FORMAT') fora.push(`${m} ${caminho}: ${r.status} ${codigo(r)}`);
    }
  }
  assert.deepEqual(fora, []);
});

test('3. caractere nulo ou metade solta de par sub-rogado: 400 INVALID_TEXT_CHARACTER com o campo; nada é gravado nem enfileirado', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const filaAntes = await contarFila();
  const msgAntes = await contarMensagens();
  const NUL = 'a\u0000b';
  const SUR = 'a\ud800b';
  const txt = { kind: 'text', text: 'ok', personId: pessoa.id, to: pessoa.phone };
  const mid = { kind: 'media', mediaRef: foto.id, personId: pessoa.id, to: pessoa.phone };
  const tpl = { kind: 'template', templateName: UMA_VAR, templateVars: ['ok'], personId: pessoa.id, to: pessoa.phone };
  const casos = [
    ['/messages/send', { ...txt, text: NUL }, 'text'], ['/messages/send', { ...txt, text: SUR }, 'text'], ['/messages/send', { ...txt, text: 'fim \udc00' }, 'text'],
    ['/messages/send', { ...mid, caption: NUL }, 'caption'], ['/messages/send', { ...mid, caption: SUR }, 'caption'],
    ['/messages/send', { ...tpl, templateVars: [NUL] }, 'templateVars'], ['/messages/send', { ...tpl, templateVars: [SUR] }, 'templateVars'],
    ['/messages', { channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: NUL }, 'body'],
    ['/messages', { channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: SUR }, 'body'],
    ['/messages', { channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: 'ok', externalMessageId: NUL }, 'externalMessageId'],
  ];
  const fora = [];
  for (const [caminho, corpo, campo] of casos) {
    const r = await pedir('POST', caminho, { corpo: JSON.stringify(corpo) });
    const campos = r.json && r.json.error && r.json.error.details ? r.json.error.details.fields : null;
    if (r.status !== 400 || codigo(r) !== 'INVALID_TEXT_CHARACTER' || JSON.stringify(campos) !== JSON.stringify([campo]) || !new RegExp(`"${campo}"`).test(r.json.error.message)) fora.push(`POST ${caminho} ${campo}: ${r.status} ${codigo(r)}`);
  }
  for (const q of ['/messages?personId=%00', `/people?search=a%00b`]) {
    const r = await pedir('GET', q);
    if (r.status !== 400 || codigo(r) !== 'INVALID_TEXT_CHARACTER') fora.push(`GET ${q}: ${r.status} ${codigo(r)}`);
  }
  assert.deepEqual(fora, [], 'esperado 400 INVALID_TEXT_CHARACTER com o campo');
  assert.equal(await contarFila(), filaAntes, 'nenhum envio entrou na fila');
  assert.equal(await contarMensagens(), msgAntes, 'nenhuma mensagem foi gravada');
  // controle: emoji (par completo) e acento passam e o texto chega inteiro ao envio
  const ok = await pedir('POST', '/messages/send', { corpo: JSON.stringify({ ...txt, text: 'Olá 😀 ação' }) });
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
  const [snap] = await env.sql(A, 'SELECT payload_snapshot FROM integration.dispatches WHERE id = :id', { id: ok.json.data.dispatchId });
  assert.equal(snap.payload_snapshot.text, 'Olá 😀 ação');
});

test('4. texto livre acima do limite do canal: 400 MESSAGE_VALIDATION com o campo; o limite é parâmetro da empresa; 20 MB respondem em menos de 2 s', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const base = { kind: 'text', personId: pessoa.id, to: pessoa.phone };
  const filaAntes = await contarFila();
  const longo = [
    [{ ...base, text: 'x'.repeat(4097) }, 'text', 4096],
    [{ ...base, text: '😀'.repeat(4097) }, 'text', 4096],
    [{ kind: 'media', mediaRef: foto.id, personId: pessoa.id, to: pessoa.phone, caption: 'c'.repeat(1025) }, 'caption', 1024],
    [{ kind: 'template', templateName: UMA_VAR, templateVars: ['v'.repeat(1025)], personId: pessoa.id, to: pessoa.phone }, 'templateVars', 1024],
  ];
  const fora = [];
  const confere = (rotulo, r, campo, max) => {
    const det = r.json && r.json.error ? r.json.error.details : null;
    if (r.status !== 400 || codigo(r) !== 'MESSAGE_VALIDATION' || JSON.stringify(det) !== JSON.stringify({ fields: [campo], maxChars: max })
      || !new RegExp(`"${campo}" aceita no máximo ${max} caracteres`).test(r.json.error.message)) fora.push(`${rotulo}: ${r.status} ${codigo(r)}`);
  };
  for (const [corpo, campo, max] of longo) confere(`POST /messages/send ${campo} acima de ${max}`, await pedir('POST', '/messages/send', { corpo: JSON.stringify(corpo) }), campo, max);
  confere('POST /messages body acima de 65536', await pedir('POST', '/messages', { corpo: JSON.stringify({ channel: 'EMAIL', direction: 'INBOUND', authorType: 'CLIENT', body: 'b'.repeat(65537) }) }), 'body', 65536);
  assert.deepEqual(fora, [], 'esperado 400 MESSAGE_VALIDATION com o campo e o limite');
  // no limite exato passa: 4096 caracteres sem espaço (emoji conta 1) e 65536 no registro
  assert.equal((await pedir('POST', '/messages/send', { corpo: JSON.stringify({ ...base, text: 'x'.repeat(4096) }) })).status, 202);
  assert.equal((await pedir('POST', '/messages/send', { corpo: JSON.stringify({ ...base, text: '😀'.repeat(4096) }) })).status, 202);
  assert.equal((await pedir('POST', '/messages', { corpo: JSON.stringify({ channel: 'EMAIL', direction: 'INBOUND', authorType: 'CLIENT', body: 'b'.repeat(65536) }) })).status, 201);
  assert.equal(await contarFila(), filaAntes + 2, 'só os dois envios dentro do limite entraram na fila');
  // o administrador aperta o limite (parâmetro da empresa)
  await env.parametro(A, 'integration.whatsapp.max_text_chars', 10);
  await env.parametro(A, 'integration.messaging.record_body_max_chars', 5);
  try {
    assert.equal((await pedir('POST', '/messages/send', { corpo: JSON.stringify({ ...base, text: '0123456789' }) })).status, 202);
    const onze = await pedir('POST', '/messages/send', { corpo: JSON.stringify({ ...base, text: '0123456789A' }) });
    assert.deepEqual([onze.status, onze.json.error.details.maxChars], [400, 10]);
    const seis = await pedir('POST', '/messages', { corpo: JSON.stringify({ channel: 'EMAIL', direction: 'INBOUND', authorType: 'CLIENT', body: '123456' }) });
    assert.deepEqual([seis.status, seis.json.error.details.maxChars], [400, 5]);
  } finally {
    await env.restaurar(A, LIMITES);
  }
  // fora da faixa do canal o parâmetro é recusado (o administrador só aperta)
  await assert.rejects(env.parametro(A, 'integration.whatsapp.max_text_chars', 4097), (e) => e.statusCode === 400);
  await assert.rejects(env.parametro(A, 'integration.whatsapp.max_caption_chars', 0), (e) => e.statusCode === 400);
  // 20 MB sem espaço (o caso que travava a API): recusado em menos de 2 s, e o servidor responde a outro pedido logo depois
  for (const [caminho, corpo] of [
    ['/messages/send', { ...base, text: 'x'.repeat(20 * 1048576) }],
    ['/messages/send', { kind: 'template', templateName: UMA_VAR, templateVars: ['z'.repeat(20 * 1048576)], personId: pessoa.id, to: pessoa.phone }],
    ['/messages', { channel: 'EMAIL', direction: 'INBOUND', authorType: 'CLIENT', body: 'y'.repeat(20 * 1048576) }],
  ]) {
    const r = await pedir('POST', caminho, { corpo: JSON.stringify(corpo) });
    assert.deepEqual([r.status, codigo(r)], [400, 'MESSAGE_VALIDATION'], caminho);
    assert.ok(r.ms < 2000, `${caminho} 20 MB: ${r.ms} ms`);
  }
  assert.equal((await pedir('GET', `/messages/${manual.json.data.id}`)).status, 200);
});

test('5. consulta nas rotas sem filtro: 400 MESSAGE_VALIDATION com o nome do parâmetro (antes era ignorada)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const id = manual.json.data.id;
  const casos = [
    ['GET', `/messages/${id}?x=1`, undefined, 'x'],
    ['PATCH', `/messages/${id}/status?status=LIXO`, '{"status":"READ"}', 'status'],
    ['POST', `/messages/${id}/send-alternate?y=1`, undefined, 'y'],
    ['POST', `/messages/${id}/refresh-status?z=1`, undefined, 'z'],
    ['POST', '/messages?direction=INBOUND', JSON.stringify({ channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT', body: 'q' }), 'direction'],
    ['POST', '/messages/send?kind=text', JSON.stringify({ kind: 'text', text: 'q', personId: pessoa.id, to: pessoa.phone }), 'kind'],
  ];
  const fora = [];
  for (const [m, caminho, corpo, campo] of casos) {
    const r = await pedir(m, caminho, { corpo });
    const campos = r.json && r.json.error && r.json.error.details ? r.json.error.details.fields : null;
    if (r.status !== 400 || codigo(r) !== 'MESSAGE_VALIDATION' || JSON.stringify(campos) !== JSON.stringify([campo])) fora.push(`${m} ${caminho}: ${r.status} ${codigo(r)}`);
  }
  assert.deepEqual(fora, [], 'esperado 400 MESSAGE_VALIDATION com o nome do parâmetro');
  assert.equal((await pedir('GET', `/messages/${id}`)).status, 200, 'sem consulta continua 200');
  assert.equal((await pedir('GET', `/messages?personId=${pessoa.id}`)).status, 200, 'o filtro do GET /messages continua');
});

test('nenhuma resposta deste arquivo passou de 2 s', (t) => {
  if (skipReason) return t.skip(skipReason);
  const lentas = TEMPOS.filter((x) => x.ms >= 2000).map((x) => `${x.rotulo}: ${x.ms} ms`);
  t.diagnostic(`pedidos: ${TEMPOS.length}; mais lento: ${Math.max(...TEMPOS.map((x) => x.ms))} ms`);
  assert.deepEqual(lentas, []);
});
