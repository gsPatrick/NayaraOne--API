'use strict';

// M3-18, parte de Pessoas ("Consentimento, finalidade e ACESSO a dados pessoais"; livro §20 "Exportação e acesso sensível auditados", §18
// "IA acessar outro cliente: permission-aware retrieval/RLS", §7 checklist "RLS bloqueia outra empresa"). Pela API real (login, JWT, RLS e a
// política de VIEW do DLP), com os perfis de CI do seed:
//   - quem não tem people:read não lê nada de Pessoas (403);
//   - quem lê sem a permissão dedicada governance:dlp:view-restricted vê CPF e leitura de documento MASCARADOS, e a leitura é auditada
//     como governance.dlp.view.blocked (sem o valor);
//   - quem tem a permissão dedicada vê em claro, e a leitura sensível é auditada como governance.dlp.view;
//   - outra empresa não acha a pessoa (404).
// Rodar só em banco descartável: node scripts/withDisposableDb.js -- ... (CI_TENANT_USERS_PASSWORD e o seed de dois tenants).
process.env.PORT = process.env.PEOPLE_ACESSO_HTTP_TEST_PORT || '21841';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomCpf } = require('./helpers/pessoasVinculo');
const { iniciar, stopHttp, adminQuery } = require('./helpers/pessoasHttpEvidencia');

let http; let gravar; let pessoaId; let cpf;
const SUF = `${Date.now()}`;

before(async () => {
  ({ http, gravar } = await iniciar({
    port: process.env.PORT, arquivo: 'people.acessoDadosPessoais.http',
    logins: { gestorA: ['A', 'gestor'], mascarado: ['A', 'mascarado'], claro: ['A', 'claro'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] },
  }));
  if (http.skip) return;
  cpf = randomCpf();
  const r = await http.call('gestorA', 'POST', '/people', {
    personType: 'PF', legalName: `Acesso${SUF} Dados Teixeira`, taxIdNormalized: cpf, birthOrFoundationDate: '1979-06-15',
    contacts: [{ contactType: 'EMAIL', valueNormalized: `acesso.${SUF}@exemplo.com`, isPrimary: true }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  pessoaId = r.body.data.id;
  const doc = await http.call('gestorA', 'POST', `/people/${pessoaId}/documents/ingest`, {
    fileName: 'rg.pdf', mimeType: 'application/pdf', documentType: 'RG',
    contentBase64: Buffer.from(JSON.stringify({ __mockOcr: { fields: { name: `Acesso${SUF} Dados Teixeira`, taxId: cpf }, confidence: 0.95 } })).toString('base64'),
  });
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
});

after(async () => {
  if (gravar) gravar({ linha: 'M3-18 (parte de Pessoas)', pessoaDeTeste: pessoaId || null });
  await stopHttp({});
});

const auditoria = async (acao, perfil) => (await adminQuery(
  `SELECT a.after_json FROM audit.audit_log a JOIN core.users u ON u.id = a.user_id WHERE a.action = $1 AND a.entity_id = $2 AND u.email = $3`,
  [acao, pessoaId, `ci-a-${perfil}@ci.nayaraone.test`]
)).rows;

test('M3-18 sem people:read: a ficha, a lista e os documentos de Pessoas são negados (403)', async (t) => {
  if (http.skip) return t.skip(http.skip);
  for (const rota of [`/people/${pessoaId}`, '/people', `/people/${pessoaId}/documents`, `/people/${pessoaId}/contacts`]) {
    const r = await http.call('leituraA', 'GET', rota);
    assert.equal(r.status, 403, `${rota}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  }
});

test('M3-18 leitura sem a permissão dedicada: CPF e a leitura do documento saem mascarados, e a leitura é auditada sem o valor', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const ficha = await http.call('mascarado', 'GET', `/people/${pessoaId}`);
  assert.equal(ficha.status, 200, JSON.stringify(ficha.body));
  assert.notEqual(ficha.body.data.taxIdNormalized, cpf);
  assert.equal(ficha.body.data.taxIdNormalized, `***.***.***-${cpf.slice(-2)}`);
  assert.equal(JSON.stringify(ficha.body).includes(cpf), false, 'o CPF em claro não pode aparecer em lugar nenhum da ficha');
  const lista = await http.call('mascarado', 'GET', '/people');
  assert.equal(lista.status, 200);
  assert.equal(JSON.stringify(lista.body).includes(cpf), false, 'nem na lista');
  const docs = await http.call('mascarado', 'GET', `/people/${pessoaId}/documents`);
  assert.equal(docs.status, 200, JSON.stringify(docs.body));
  assert.equal(JSON.stringify(docs.body).includes(cpf), false, 'nem na leitura do documento');
  const linhas = await auditoria('governance.dlp.view.blocked', 'mascarado');
  assert.ok(linhas.some((l) => l.after_json.classification === 'RESTRICTED' && l.after_json.decision === 'DENY'), JSON.stringify(linhas));
  assert.equal(JSON.stringify(linhas).includes(cpf), false, 'a auditoria não guarda o valor');
});

test('M3-18 leitura com a permissão dedicada: CPF em claro e a leitura sensível auditada (governance.dlp.view)', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const ficha = await http.call('claro', 'GET', `/people/${pessoaId}`);
  assert.equal(ficha.status, 200, JSON.stringify(ficha.body));
  assert.equal(ficha.body.data.taxIdNormalized, cpf);
  const linhas = await auditoria('governance.dlp.view', 'claro');
  assert.ok(linhas.some((l) => l.after_json.classification === 'RESTRICTED' && l.after_json.decision === 'ALLOW'), JSON.stringify(linhas));
  assert.equal(JSON.stringify(linhas).includes(cpf), false);
});

test('M3-18 outra empresa não acha a pessoa nem os dados dela (404), e a lista dela não traz a pessoa', async (t) => {
  if (http.skip) return t.skip(http.skip);
  for (const rota of [`/people/${pessoaId}`, `/people/${pessoaId}/documents`, `/people/${pessoaId}/contacts`]) {
    const r = await http.call('gestorB', 'GET', rota);
    assert.equal(r.status, 404, `${rota}: ${JSON.stringify(r.body)}`);
  }
  const lista = await http.call('gestorB', 'GET', '/people');
  assert.equal(lista.body.data.some((p) => p.id === pessoaId), false);
});
