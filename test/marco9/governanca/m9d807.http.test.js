'use strict';

// M9-D807 — PATCH /people/:id pela API real: changeEvidence no corpo, recusas 422 e SYSTEM_IMPORT nunca vindo de rota HTTP.
// Banco descartável (nunca o .env remoto). Pessoa e arquivo são criados com commit; o cluster é apagado ao final.
process.env.PORT = process.env.M9D807_HTTP_TEST_PORT || '21657';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

let baseUrl; let tenants; let token; let appLoaded = false; let httpSkip = null;

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  require('../../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  let res; let body;
  for (let i = 0; i < 5; i += 1) {
    res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', 'gestor'), password }) });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
  }
  assert.equal(res.status, 200, 'login');
  token = body.data.accessToken;
});

after(async () => {
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const patch = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

async function newPerson() {
  const { rows: [row] } = await adminQuery(
    `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES ($1, $2, $3, 'PF', $4, 'ACTIVE') RETURNING id`,
    [randomUUID(), tenants.A.groupId, tenants.A.companyId, `QA-M9 Pessoa ${randomUUID().slice(0, 6)}`]
  );
  return row.id;
}

async function newFile() {
  const { rows: [row] } = await adminQuery(
    `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, checksum_sha256, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 'comprovante.pdf', 'application/pdf', 10, $4, $5) RETURNING id`,
    [tenants.A.groupId, tenants.A.companyId, `qa-m9/${randomUUID()}`, 'c'.repeat(64), tenants.A.userId]
  );
  return row.id;
}

test('m9d807 PATCH de pessoa: sem evidência 422, com comprovante 200 e linha de evidência com a fonte', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const cpf = require('../_helpers/m9d807Env').cpf();
  const id = await newPerson();
  const noEvidence = await patch(`/people/${id}`, { taxIdNormalized: cpf });
  assert.equal(noEvidence.status, 422);
  assert.equal(noEvidence.body.error.code, 'GOV_EVIDENCE_REQUIRED');
  assert.equal(noEvidence.body.error.message, 'Informe a origem e o comprovante desta alteração.');
  const free = await patch(`/people/${id}`, { preferredName: 'Apelido QA-M9' });
  assert.equal(free.status, 200, 'campo não crítico passa sem evidência');
  const fileId = await newFile();
  const ok = await patch(`/people/${id}`, { taxIdNormalized: cpf, changeEvidence: { source: 'DOCUMENT', evidenceFileId: fileId } });
  assert.equal(ok.status, 200);
  const { rows } = await adminQuery('SELECT field, source, evidence_file_id, value_before_hash, value_after_hash FROM governance.field_change_evidence WHERE entity_id = $1', [id]);
  assert.deepEqual(rows.map((r) => [r.field, r.source, r.evidence_file_id]), [['taxIdNormalized', 'DOCUMENT', fileId]]);
  assert.equal(rows[0].value_before_hash, null);
  assert.match(rows[0].value_after_hash, /^[0-9a-f]{64}$/);
});

test('m9d807 SYSTEM_IMPORT vindo de rota HTTP é recusado com 422', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const id = await newPerson();
  const res = await patch(`/people/${id}`, { legalName: 'Nome Novo QA-M9', changeEvidence: { source: 'SYSTEM_IMPORT' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'GOV_EVIDENCE_SOURCE_INVALID');
  const short = await patch(`/people/${id}`, { legalName: 'Nome Novo QA-M9', changeEvidence: { source: 'OTHER', note: 'ok' } });
  assert.equal(short.status, 422);
  assert.equal(short.body.error.code, 'GOV_EVIDENCE_NOTE_TOO_SHORT');
  const { rows } = await adminQuery('SELECT legal_name FROM people.persons WHERE id = $1', [id]);
  assert.match(rows[0].legal_name, /^QA-M9 Pessoa/, 'nada foi gravado');
});
