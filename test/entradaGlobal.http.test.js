'use strict';

// Entrada robusta na API inteira pelo caminho HTTP real (login, JWT, tenant, RLS), verificação independente do Marco 9, rodada 7
// (`Maturacao/fechamento-m3-m6/verificacao/m9-rodada7.md`). Cada achado da rodada, nas rotas que a rodada citou:
//  1. `PUT /settings/<chave numérica>` com `value` aninhado fundo: 400, sem o valor em `details`, e a API segue respondendo (DI-M9R-18, DI-M9R-19);
//  2. tipo errado no corpo (objeto, lista ou número onde a rota espera texto ou id): 400 com o campo, nas rotas citadas (DI-M9R-21);
//  3. JSON aninhado fundo (corpo inteiro e campo, com e sem Idempotency-Key): 400 REQUEST_BODY_TOO_DEEP; número infinito: 400 (DI-M9R-18);
//  4. texto maior que a coluna: 400 com o campo, nunca o valor (DI-M9R-20, DI-M9R-21);
//  5. o mecanismo geral fora das rotas validadas: erro de dado do banco (classes 22 e 23) e erro de tipo com prova no pedido viram 400 (DI-M9R-20/21);
//  6. o tamanho dos textos nos esquemas da porta é o tamanho da coluna no banco (o limite vem do modelo e o modelo não pode divergir do banco);
//  7. a conexão keep-alive ociosa por mais de 5 s continua aceitando pedido (DI-M9R-19; na sonda r7, um pedido depois de 6,7 s saiu sem resposta);
//  8. o método CONNECT recebe 404 ROUTE_NOT_FOUND como os outros métodos sem rota (o Node só fechava a conexão).
// Toda resposta é medida: nenhuma passa de 2 s. GRAVA de verdade: só em banco descartável (DISPOSABLE_DB=1) ou no CI, depois do seed de dois tenants.

process.env.PORT = process.env.ENTRADA_GLOBAL_HTTP_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const env = require('./marco9/_helpers/m9d230Env');
const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-entrada-global-${SUFIXO}@ci.nayaraone.test`;
const TEMPOS = [];
let skipReason = null;
let A; let token; let pessoa;

function pedir(method, path, { corpo, semToken = false, headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = { 'Content-Type': 'application/json', ...(semToken ? {} : { Authorization: `Bearer ${token}` }), ...headers };
    const buf = corpo === undefined ? undefined : Buffer.from(corpo);
    if (buf) h['Content-Length'] = buf.length;
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), method, path: `/api/v1${path}`, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_e) { json = null; }
        const ms = Date.now() - t0; TEMPOS.push([`${method} ${path}`, ms]);
        resolve({ status: res.statusCode, json, ms });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('sem resposta em 20 s')));
    req.on('error', (e) => resolve({ status: 0, json: null, erro: e.message, ms: Date.now() - t0 }));
    if (buf) req.write(buf);
    req.end();
  });
}
const json = (o) => JSON.stringify(o);
const fundo = (n, tipo = 'obj') => (tipo === 'obj' ? `${'{"a":'.repeat(n)}1${'}'.repeat(n)}` : `${'['.repeat(n)}1${']'.repeat(n)}`);
const comCampo = (base, campo, cru) => json({ ...base, [campo]: '__X__' }).replace('"__X__"', cru);
const codigo = (r) => (r.json && r.json.error ? r.json.error.code : null);
const campos = (r) => (r.json && r.json.error && r.json.error.details ? r.json.error.details.fields : undefined);

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  A = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await env.parametro(A, 'governanca.api.rate_limit.habilitado', false);
  const ps = await Permission.findAll();
  const user = await User.create({ name: 'CI entrada global', email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI ENTRADA GLOBAL ${SUFIXO}`, description: 'Perfil fictício do teste da entrada global (todas as permissões).', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId: user.id, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  await new Promise((s) => setTimeout(s, 300));
  for (let i = 0; i < 5 && !token; i += 1) {
    const r = await pedir('POST', '/auth/login', { corpo: json({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: A.companyId }), semToken: true });
    if (r.status === 200) token = r.json.data.accessToken; else await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  assert.ok(token, 'login do usuário do teste');
  const p = await pedir('POST', '/people', { corpo: json({ personType: 'PF', legalName: `CI global ${SUFIXO}`, allowDuplicate: true }) });
  assert.equal(p.status, 201, json(p.json));
  pessoa = p.json.data.id;
});

after(async () => {
  if (A) await env.restaurar(A, ['governanca.api.rate_limit.habilitado']).catch(() => {});
  await env.sequelize.close().catch(() => {});
  process.exit(0); // a API deste processo segue ouvindo; o arquivo termina aqui, como os demais testes HTTP
});

const rodar = (nome, fn) => test(nome, async (t) => { if (skipReason) { t.skip(skipReason); return; } await fn(); });

rodar('1. PUT /settings com value aninhado fundo: 400 sem o valor, e a API continua respondendo', async () => {
  for (const chave of ['integration.messaging.inbound_lead_prazo_horas', 'integration.whatsapp.max_text_chars']) {
    for (const n of [5000, 50000]) {
      const r = await pedir('PUT', `/settings/${chave}`, { corpo: `{"value":${fundo(n)}}` });
      assert.deepEqual([r.status, codigo(r), campos(r)], [400, 'REQUEST_BODY_TOO_DEEP', ['value']], `${chave} ${n}: ${r.status} ${r.erro || ''}`);
    }
    // abaixo do limite de profundidade: a recusa da chave numérica leva só a chave, nunca o valor recebido
    const raso = await pedir('PUT', `/settings/${chave}`, { corpo: `{"value":${fundo(40)}}` });
    assert.deepEqual([raso.status, codigo(raso), raso.json.error.details], [400, 'SETTING_INVALID_VALUE', { key: chave }]);
  }
  const vivo = await pedir('GET', '/people');
  assert.equal(vivo.status, 200, 'a API segue atendendo');
});

rodar('2. tipo errado no corpo das rotas citadas: 400 com o nome do campo (antes: 500)', async () => {
  const errados = ['{"x":1}', '["a","b"]', '12345', '1e20', 'true'];
  for (const cru of errados) {
    const login = await pedir('POST', '/auth/login', { corpo: comCampo({ password: 'x'.repeat(12) }, 'email', cru), semToken: true });
    assert.deepEqual([login.status, codigo(login), campos(login)], [400, 'AUTH_VALIDATION', ['email']], `login email=${cru}`);
    const p = await pedir('POST', '/people', { corpo: comCampo({ legalName: `CI ${SUFIXO}`, allowDuplicate: true }, 'personType', cru) });
    assert.deepEqual([p.status, codigo(p), campos(p)], [400, 'PERSON_VALIDATION', ['personType']], `people personType=${cru}`);
    const o = await pedir('POST', '/opportunities', { corpo: comCampo({ nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 864e5).toISOString() }, 'personId', cru) });
    assert.deepEqual([o.status, codigo(o), campos(o)], [400, 'OPPORTUNITY_VALIDATION', ['personId']], `opportunities personId=${cru}`);
    const rd = await pedir('POST', '/radar', { corpo: comCampo({ criteriaJson: { required: { city: 'X' }, preferences: [] } }, 'personId', cru) });
    assert.deepEqual([rd.status, codigo(rd), campos(rd)], [400, 'RADAR_VALIDATION', ['personId']], `radar personId=${cru}`);
  }
  // data que não é data: o banco recusa (classe 22) e a resposta é 400, não 500
  const data = await pedir('POST', '/opportunities', { corpo: json({ personId: pessoa, nextAction: 'Ligar', nextActionDueAt: 'amanhã cedo' }) });
  assert.deepEqual([data.status, codigo(data)], [400, 'INVALID_DATE_VALUE']);
  // o caminho certo continua funcionando
  const ok = await pedir('POST', '/opportunities', { corpo: json({ personId: pessoa, nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 864e5).toISOString() }) });
  assert.equal(ok.status, 201, json(ok.json));
});

rodar('3. JSON aninhado fundo nas rotas citadas (com e sem Idempotency-Key) e número infinito: 400 na porta', async () => {
  const rotas = [
    ['POST', '/dlp/copy-events', { resourceType: 'finance.bank_account', resourceId: '9d3b6a0e-0000-4000-8000-000000000001', field: 'accountNumber', outcome: 'DENIED' }],
    ['POST', '/finance/entries', { entryType: 'DEBIT', nature: 'PAYABLE', amount: 12.5, description: `CI ${SUFIXO}` }],
    ['POST', '/files', { fileName: 'a.png', mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=', category: 'generic' }],
    ['POST', '/people', { personType: 'PF', legalName: `CI ${SUFIXO}`, allowDuplicate: true }],
    ['POST', '/opportunities', { personId: pessoa, nextAction: 'Ligar' }],
    ['POST', '/radar', { personId: pessoa, criteriaJson: { required: {}, preferences: [] } }],
  ];
  for (const [m, p, base] of rotas) {
    for (const n of [1000, 5000, 50000]) {
      for (const tipo of ['obj', 'arr']) {
        const idem = { 'Idempotency-Key': `ci-global-${SUFIXO}-${p}-${n}-${tipo}` };
        const inteiro = await pedir(m, p, { corpo: fundo(n, tipo), headers: idem });
        assert.deepEqual([inteiro.status, codigo(inteiro)], [400, 'REQUEST_BODY_TOO_DEEP'], `${p} corpo ${tipo} ${n}`);
        const campo = Object.keys(base)[0];
        const r = await pedir(m, p, { corpo: comCampo(base, campo, fundo(n, tipo)), headers: { 'Idempotency-Key': `${idem['Idempotency-Key']}-c` } });
        assert.deepEqual([r.status, codigo(r), campos(r)], [400, 'REQUEST_BODY_TOO_DEEP', [campo]], `${p} campo ${campo} ${tipo} ${n}`);
      }
    }
    const inf = await pedir(m, p, { corpo: comCampo(base, 'amount', '1e400') });
    assert.deepEqual([inf.status, codigo(inf), campos(inf)], [400, 'REQUEST_BODY_NUMBER_OUT_OF_RANGE', ['amount']], `${p} 1e400`);
  }
  // aninhamento legítimo (abaixo do limite) passa
  const raso = await pedir('POST', '/radar', { corpo: json({ personId: pessoa, criteriaJson: { required: { city: 'X' }, preferences: [], extra: JSON.parse(fundo(20)) } }) });
  assert.equal(raso.status, 201, json(raso.json));
});

rodar('4. texto maior que a coluna: 400 com o campo e sem o valor (antes: 500 value too long)', async () => {
  const casos = [
    ['POST', '/people', { personType: 'PF', legalName: 'L'.repeat(201), allowDuplicate: true }, 'PERSON_VALIDATION', 'legalName'],
    ['POST', '/people', { personType: 'PF', legalName: `CI ${SUFIXO}`, preferredName: 'P'.repeat(151), allowDuplicate: true }, 'PERSON_VALIDATION', 'preferredName'],
    ['PATCH', `/people/${pessoa}`, { preferredName: 'P'.repeat(151) }, 'PERSON_VALIDATION', 'preferredName'],
    ['POST', '/properties', { title: 'T'.repeat(256), internalCode: `CI-${SUFIXO}`, propertyType: 'RESIDENTIAL' }, 'PROPERTY_VALIDATION', 'title'],
    ['POST', '/properties', { title: `CI ${SUFIXO}`, internalCode: 'C'.repeat(41), propertyType: 'RESIDENTIAL' }, 'PROPERTY_VALIDATION', 'internalCode'],
  ];
  for (const [m, p, corpo, cod, campo] of casos) {
    const r = await pedir(m, p, { corpo: json(corpo) });
    assert.deepEqual([r.status, codigo(r), campos(r)], [400, cod, [campo]], `${m} ${p} ${campo}`);
    assert.ok(!JSON.stringify(r.json).includes('PPPPPPPPPP') && !JSON.stringify(r.json).includes('TTTTTTTTTT'), 'o valor não volta na resposta');
  }
  // o limite conta caracteres como o banco (um emoji é 1): 200 emojis cabem em legalName
  const emoji = await pedir('POST', '/people', { corpo: json({ personType: 'PF', legalName: '🙂'.repeat(200), allowDuplicate: true }) });
  assert.equal(emoji.status, 201, json(emoji.json));
});

rodar('5. mecanismo geral, em rotas sem esquema na porta: tipo errado, identificador inexistente e texto longo viram 400 com o campo', async () => {
  // "Invalid value" do Sequelize (objeto como valor de uma consulta) e 42883 (número comparado com texto): 400 INVALID_FIELD_TYPE
  const mov = await pedir('POST', '/inventory/movements', { corpo: json({ inventoryItemId: { x: 1 }, movementType: 'OUT', quantity: 2, sourceType: 'MANUAL', reason: 'CI' }) });
  assert.deepEqual([mov.status, codigo(mov), campos(mov)], [400, 'INVALID_FIELD_TYPE', ['inventoryItemId']], json(mov.json));
  const clausula = await pedir('POST', '/legal/clauses', { corpo: json({ code: 12345, title: 'CI', bodyText: 'Texto.', category: 'GENERAL' }) });
  assert.deepEqual([clausula.status, codigo(clausula)], [400, 'INVALID_FIELD_TYPE'], json(clausula.json));
  // identificador que não existe (chave estrangeira, classe 23): 400 REFERENCE_NOT_FOUND com o campo e sem o id
  const inexistente = '9d3b6a0e-0000-4000-8000-0000000000ff';
  const tx = await pedir('POST', '/finance/bank-transactions', { corpo: json({ bankAccountId: inexistente, amount: -10.5, transactionDate: new Date().toISOString() }) });
  assert.deepEqual([tx.status, codigo(tx), campos(tx)], [400, 'REFERENCE_NOT_FOUND', ['bankAccountId']], json(tx.json));
  assert.ok(!JSON.stringify(tx.json).includes(inexistente), 'o id do detalhe do banco não volta');
  // texto maior que a coluna numa rota sem esquema (classe 22): 400 VALUE_TOO_LONG com o campo, pelo comando do Sequelize
  const centro = await pedir('POST', '/finance/cost-centers', { corpo: json({ name: 'N'.repeat(5000), code: `CI${SUFIXO}`.slice(0, 20) }) });
  assert.deepEqual([centro.status, codigo(centro), campos(centro)], [400, 'VALUE_TOO_LONG', ['name']], json(centro.json));
  assert.ok(!JSON.stringify(centro.json).includes('NNNNNNNNNN'), 'o texto não volta na resposta');
});

rodar('6. o tamanho de texto dos esquemas da porta é o tamanho da coluna no banco', async () => {
  const { sequelize } = require('../src/models');
  const esquemas = [require('../src/features/people/people.schema').ESQUEMAS, require('../src/features/properties/properties.schema').ESQUEMAS,
    require('../src/features/crm/opportunities.schema').ESQUEMAS, require('../src/features/radar/radar.schema').ESQUEMAS, require('../src/features/auth/auth.schema').ESQUEMAS];
  const comColuna = [];
  const pilha = esquemas.flatMap((e) => Object.values(e));
  while (pilha.length) {
    const no = pilha.pop();
    if (!no || typeof no !== 'object') continue;
    if (typeof no.coluna === 'string') comColuna.push(no);
    for (const v of Object.values(no)) if (v && typeof v === 'object') pilha.push(v);
  }
  assert.ok(comColuna.length >= 20, `campos com coluna: ${comColuna.length}`);
  const divergentes = [];
  for (const no of comColuna) {
    const [modelo, atributo] = no.coluna.split('.');
    const M = sequelize.models[modelo];
    const tabela = M.getTableName();
    const [linhas] = await sequelize.query('SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_schema = :s AND table_name = :t AND column_name = :c',
      { replacements: { s: tabela.schema || 'public', t: tabela.tableName || tabela, c: M.rawAttributes[atributo].field } });
    const banco = linhas.length === 1 ? (linhas[0].n === null ? undefined : Number(linhas[0].n)) : 'sem coluna';
    if (banco !== no.maxCaracteres) divergentes.push(`${no.coluna}: banco ${banco}, esquema ${no.maxCaracteres}`);
  }
  assert.deepEqual([...new Set(divergentes)], []);
});

rodar('7. conexão keep-alive ociosa por mais de 5 s continua aceitando pedido (antes: ECONNRESET, pedido sem resposta)', async () => {
  assert.equal(require('../app').server.keepAliveTimeout, 65000, 'o servidor da API usa o prazo de 65 s');
  const agente = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const pedirNoAgente = () => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), method: 'GET', path: '/api/v1/people', agent: agente, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
    });
    req.on('error', (e) => resolve({ status: 0, erro: e.code }));
    req.end();
  });
  const primeiro = await pedirNoAgente();
  assert.equal(primeiro.status, 200);
  await new Promise((s) => setTimeout(s, 6500));
  const segundo = await pedirNoAgente();
  agente.destroy();
  assert.deepEqual([segundo.status, segundo.reused], [200, true], `depois de 6,5 s ociosa a mesma conexão responde (${JSON.stringify(segundo)})`);
});

rodar('8. método CONNECT recebe resposta 404 ROUTE_NOT_FOUND, como os outros métodos sem rota (antes: a conexão só era fechada, sem resposta)', async () => {
  const net = require('node:net');
  const resposta = await new Promise((resolve) => {
    const s = net.connect(Number(process.env.PORT), '127.0.0.1');
    let txt = '';
    s.on('data', (c) => { txt += c.toString('latin1'); });
    s.on('close', () => resolve(txt));
    s.on('error', () => resolve(txt));
    s.write('CONNECT 127.0.0.1:5432 HTTP/1.1\r\nHost: 127.0.0.1:5432\r\n\r\n');
    setTimeout(() => s.destroy(), 3000);
  });
  assert.match(resposta, /^HTTP\/1\.1 404 /, `resposta: ${JSON.stringify(resposta.slice(0, 80))}`);
  assert.match(resposta, /ROUTE_NOT_FOUND/);
});

rodar('nenhuma resposta passou de 2 s', async () => {
  const lentas = TEMPOS.filter(([, ms]) => ms >= 2000);
  assert.deepEqual(lentas, []);
});
