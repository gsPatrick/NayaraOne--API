'use strict';

// Controle de acesso a arquivos — revisão independente do RBAC-02 (conferência Nayara 18/10/2026).
//   I1 — vincular arquivo exige já poder lê-lo (sem isso, vincular virava escalada de leitura);
//   I2 — a categoria do upload (vinda do cliente) só conta enquanto o arquivo não tem vínculo;
//        cada TIPO de referência é exercitado com arquivo `generic`, como o Front envia;
//   I3 — o uploader só lê o próprio arquivo enquanto ele não tem dono;
//   I4 — a leitura confere a integridade (marcador de cifra, tag AES-GCM e checksum SHA-256);
//   admin — administrador é a role de SISTEMA "ADMIN", não qualquer role chamada "admin".
// Fixtures COMMITADAS (as requisições HTTP rodam em transações próprias), marcadas "FACL".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.PORT = process.env.FILES_ACL_HTTP_TEST_PORT || '21620';

require('../app');
const {
  sequelize,
  getSeedTenant,
  withTenantTransaction,
  withRollbackTenantTransaction,
  uniqueSuffix,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const filesService = require('../src/features/files/files.service');
const fileAccessService = require('../src/features/files/fileAccess.service');
const contractsService = require('../src/features/legal/contracts.service');
const projectsService = require('../src/features/construction/projects.service');
const diskStorage = require('../src/utils/diskStorage');
const { User, Role, UserMembership, Company, File, AuditLog } = require('../src/models');

let tenant;
let baseUrl;
let uploader; // usuário que envia os arquivos (sem nenhuma permissão nos tokens de leitura)
let reader; // usuário que lê — nunca é o uploader
let companyB; // empresa REAL, mesmo grupo

async function realUser(label) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-facl-${label}@nayaraone.dev` },
    defaults: { name: `HOMO QA — FACL ${label}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return user;
}

function token(userId, permissions, ctx = tenant) {
  return signAccessToken({ sub: userId, group_id: ctx.groupId, company_id: ctx.companyId, roles: ['facl'], permissions });
}

async function get(pathName, userId, permissions, ctx) {
  const res = await fetch(`${baseUrl}${pathName}`, { headers: { Authorization: `Bearer ${token(userId, permissions, ctx)}` } });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  return { status: res.status, code: body?.error?.code };
}

async function post(pathName, userId, permissions, payload) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(userId, permissions)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body?.error?.code, data: body?.data };
}

async function upload(userId, { category, content } = {}) {
  return withTenantTransaction(tenant, (t) =>
    filesService.uploadFile(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        fileName: `facl-${uniqueSuffix()}.pdf`,
        mimeType: 'application/pdf',
        contentBase64: Buffer.from(content || `%PDF-1.4 FACL ${uniqueSuffix()}`).toString('base64'),
        ...(category ? { category } : {}),
      },
      userId,
      t
    )
  );
}

// Um vínculo real por TIPO de referência mapeado em fileAccess.service.
const LINKERS = {
  // uuid escalar — legal.contract_requirements.satisfied_by_file_id → legal:read
  async uuid(fileId) {
    return withTenantTransaction(tenant, async (t) => {
      const contract = await contractsService.createContract(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
        tenant.userId,
        t
      );
      await sequelize.query(
        `INSERT INTO legal.contract_requirements (id, group_id, company_id, contract_id, requirement_code, description, requirement_type, satisfied_by_file_id, status, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :contract, :code, 'FACL documento', 'DOCUMENT', :file, 'SATISFIED', now(), now())`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, contract: contract.id, code: `FACL-${uniqueSuffix()}`, file: fileId }, transaction: t }
      );
    });
  },
  // uuid[] — construction.daily_reports.evidence_file_ids → construction:read
  async uuid_array(fileId) {
    return withTenantTransaction(tenant, async (t) => {
      const project = await projectsService.createProject(
        { groupId: tenant.groupId, companyId: tenant.companyId, name: `FACL Obra vínculo ${uniqueSuffix()}`, managerUserId: tenant.userId },
        tenant.userId,
        t
      );
      await sequelize.query(
        `INSERT INTO construction.daily_reports (id, group_id, company_id, project_id, report_date, evidence_file_ids, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :project, '2026-01-15', ARRAY[CAST(:file AS uuid)], now(), now())`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, project: project.id, file: fileId }, transaction: t }
      );
    });
  },
  // jsonb com array de ids — procurement.supplier_qualifications.document_file_ids → procurement:read
  async jsonb_array(fileId) {
    return withTenantTransaction(tenant, async (t) => {
      const [[person]] = await sequelize.query(
        `INSERT INTO people.persons (id, group_id, company_id, legal_name, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :name, now(), now()) RETURNING id`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, name: `FACL Fornecedor ${uniqueSuffix()}` }, transaction: t }
      );
      await sequelize.query(
        `INSERT INTO procurement.supplier_qualifications (id, group_id, company_id, supplier_person_id, document_file_ids, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :person, jsonb_build_array(CAST(:file AS text)), now(), now())`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, person: person.id, file: fileId }, transaction: t }
      );
    });
  },
  // people.file_links — AssetMovement → inventory:read
  async file_links(fileId) {
    return withTenantTransaction(tenant, (t) =>
      sequelize.query(
        `INSERT INTO people.file_links (id, group_id, company_id, file_id, related_entity_type, related_entity_id, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :file, 'AssetMovement', gen_random_uuid(), now(), now())`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, file: fileId }, transaction: t }
      )
    );
  },
};

const OWNER_PERMISSION = { uuid: 'legal:read', uuid_array: 'construction:read', jsonb_array: 'procurement:read', file_links: 'inventory:read' };
const OTHER_PERMISSION = { uuid: 'inventory:read', uuid_array: 'legal:read', jsonb_array: 'legal:read', file_links: 'legal:read' };

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  uploader = await realUser('uploader');
  reader = await realUser('reader');
  companyB = await sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: tenant.groupId }, transaction: t });
    const [company] = await Company.findOrCreate({
      where: { groupId: tenant.groupId, name: 'HOMO QA — FACL Empresa B' },
      defaults: { groupId: tenant.groupId, name: 'HOMO QA — FACL Empresa B' },
      transaction: t,
    });
    return company;
  });
  assert.ok(companyB?.id && companyB.id !== tenant.companyId, 'empresa B real e diferente da A');
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

for (const kind of Object.keys(LINKERS)) {
  test(`I2/I3 (${kind}): arquivo generic vinculado — só a permissão do módulo dono lê; o uploader deixa de ler`, async () => {
    const file = await upload(uploader.id);
    assert.ok(file.storageKey.startsWith('generic/'), 'arquivo real chega sem categoria, como o Front envia');

    // Sem vínculo: o uploader pré-visualiza; outro usuário sem permissão não.
    assert.equal((await get(`/files/${file.id}/content`, uploader.id, [])).status, 200);
    assert.equal((await get(`/files/${file.id}/content`, reader.id, [OWNER_PERMISSION[kind]])).status, 403);

    await LINKERS[kind](file.id);

    assert.equal((await get(`/files/${file.id}/content`, reader.id, [OWNER_PERMISSION[kind]])).status, 200, 'leitura do módulo dono');
    assert.equal((await get(`/files/${file.id}`, reader.id, [OWNER_PERMISSION[kind]])).status, 200, 'metadado com a leitura do módulo dono');
    const otherModule = await get(`/files/${file.id}/content`, reader.id, [OTHER_PERMISSION[kind]]);
    assert.deepEqual([otherModule.status, otherModule.code], [403, 'FILE_ACCESS_FORBIDDEN'], 'leitura de outro módulo não basta');
    const formerUploader = await get(`/files/${file.id}/content`, uploader.id, []);
    assert.deepEqual([formerUploader.status, formerUploader.code], [403, 'FILE_ACCESS_FORBIDDEN'], 'I3: uploader sem a permissão do dono não lê mais');
  });
}

test('I2: categoria enviada pelo cliente só vale enquanto o arquivo não tem dono', async () => {
  const file = await upload(uploader.id, { category: 'contracts' });
  assert.equal((await get(`/files/${file.id}/content`, reader.id, ['legal:read'])).status, 200, 'sem vínculo, a categoria indica o módulo');

  await LINKERS.uuid_array(file.id); // passa a pertencer a um RDO de obra

  assert.equal((await get(`/files/${file.id}/content`, reader.id, ['legal:read'])).status, 403, 'a categoria "contracts" não dá mais acesso');
  assert.equal((await get(`/files/${file.id}/content`, reader.id, ['construction:read'])).status, 200);
});

test('I1: anexar arquivo de outro módulo nas evidências de um RDO é recusado (sem virar leitura)', async () => {
  const contractDoc = await upload(uploader.id);
  await LINKERS.uuid(contractDoc.id); // documento de contrato: dono legal:read
  const project = await withTenantTransaction(tenant, (t) =>
    projectsService.createProject({ groupId: tenant.groupId, companyId: tenant.companyId, name: `FACL Obra ${uniqueSuffix()}`, managerUserId: tenant.userId }, tenant.userId, t)
  );
  const construction = ['construction:create', 'construction:read'];

  const attack = await post(`/construction/projects/${project.id}/daily-reports`, reader.id, construction, {
    reportDate: '2026-03-02',
    evidenceFileIds: [contractDoc.id],
  });
  assert.deepEqual([attack.status, attack.code], [403, 'FILE_ATTACH_FORBIDDEN']);
  assert.equal((await get(`/files/${contractDoc.id}/content`, reader.id, construction)).status, 403, 'continua sem acesso ao documento');

  const [rows] = await sequelize.query(
    'SELECT count(*)::int AS n FROM construction.daily_reports WHERE project_id = :p',
    { replacements: { p: project.id } }
  );
  assert.equal(rows[0].n, 0, 'nenhum RDO gravado');

  // Controle positivo: o próprio arquivo do usuário, ainda sem dono, anexa normalmente.
  const ownPhoto = await upload(reader.id);
  const ok = await post(`/construction/projects/${project.id}/daily-reports`, reader.id, construction, {
    reportDate: '2026-03-03',
    evidenceFileIds: [ownPhoto.id],
  });
  assert.equal(ok.status, 201, `anexo legítimo: ${ok.code || ''}`);
  // Depois de anexado, o arquivo pertence a Obras: lê com construction:read.
  assert.equal((await get(`/files/${ownPhoto.id}/content`, reader.id, ['construction:read'])).status, 200);
});

test('I1 (serviço): assertCanAttachFiles aceita quem já lê o arquivo e ignora id inexistente', async () => {
  const file = await upload(uploader.id);
  await LINKERS.uuid_array(file.id);
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.doesNotReject(() => fileAccessService.assertCanAttachFiles([file.id], { userId: reader.id, companyId: tenant.companyId, permissions: ['construction:read'] }, t));
    await assert.rejects(
      () => fileAccessService.assertCanAttachFiles([file.id], { userId: reader.id, companyId: tenant.companyId, permissions: ['legal:read'] }, t),
      (err) => err.code === 'FILE_ATTACH_FORBIDDEN'
    );
    await assert.doesNotReject(() =>
      fileAccessService.assertCanAttachFiles(['00000000-0000-4000-8000-000000000000'], { userId: reader.id, companyId: tenant.companyId, permissions: [] }, t)
    );
  });
});

test('admin: a role de SISTEMA ADMIN lê arquivo sem dono; uma role criada com o nome "admin" não', async () => {
  const file = await upload(uploader.id);
  // Seed admin (membership ativa com a role de sistema ADMIN), sem nenhuma permissão no token.
  assert.equal((await get(`/files/${file.id}/content`, tenant.userId, [])).status, 200);

  const fakeAdmin = await realUser(`fake-admin-${uniqueSuffix()}`);
  await withTenantTransaction(tenant, async (t) => {
    const role = await Role.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: 'admin', description: 'FACL role com nome de admin, sem permissões', isSystem: false },
      { transaction: t }
    );
    await UserMembership.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, userId: fakeAdmin.id, roleId: role.id, status: 'ACTIVE' },
      { transaction: t }
    );
  });
  const res = await fetch(`${baseUrl}/files/${file.id}/content`, {
    headers: { Authorization: `Bearer ${signAccessToken({ sub: fakeAdmin.id, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin', 'ADMIN'], permissions: [] })}` },
  });
  assert.equal(res.status, 403, 'nome de role no token não faz ninguém administrador');
});

test('outra empresa (real, mesmo grupo): arquivo de A não existe para B, mesmo com a permissão do dono', async () => {
  const file = await upload(uploader.id);
  await LINKERS.uuid_array(file.id);
  const ctxB = { groupId: tenant.groupId, companyId: companyB.id };
  assert.equal((await get(`/files/${file.id}/content`, reader.id, ['construction:read'], ctxB)).status, 404);
  assert.equal((await get(`/files/${file.id}/content`, reader.id, ['construction:read'])).status, 200, 'controle positivo na empresa A');
});

function absolutePathOf(storageKey) {
  return path.join(diskStorage.UPLOADS_ROOT, storageKey);
}

async function integrityAuditCount(fileId) {
  return withTenantTransaction(tenant, (t) => AuditLog.count({ where: { entityId: fileId, action: 'files.integrity_violation' }, transaction: t }));
}

test('I4: byte do conteúdo cifrado adulterado em disco — a API recusa e registra o incidente', async () => {
  const file = await upload(uploader.id, { content: '%PDF-1.4 FACL integridade original' });
  await LINKERS.uuid_array(file.id);
  assert.equal((await get(`/files/${file.id}/content`, reader.id, ['construction:read'])).status, 200);

  const target = absolutePathOf(file.storageKey);
  const bytes = fs.readFileSync(target);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(target, bytes);

  const res = await get(`/files/${file.id}/content`, reader.id, ['construction:read']);
  assert.deepEqual([res.status, res.code], [409, 'FILE_INTEGRITY_VIOLATION']);
  assert.equal(await integrityAuditCount(file.id), 1, 'incidente auditado');
});

test('I4: marcador de cifra removido (conteúdo trocado por texto puro) — recusado, não vira "legado"', async () => {
  const file = await upload(uploader.id, { content: '%PDF-1.4 FACL original' });
  await LINKERS.uuid_array(file.id);
  fs.writeFileSync(absolutePathOf(file.storageKey), Buffer.from('%PDF-1.4 conteudo trocado sem marcador'));

  const res = await get(`/files/${file.id}/content`, reader.id, ['construction:read']);
  assert.deepEqual([res.status, res.code], [409, 'FILE_INTEGRITY_VIOLATION']);
  assert.equal(await integrityAuditCount(file.id), 1);
});

test('I4: arquivo legado (anterior à cifra) continua legível se íntegro e é recusado se o conteúdo não bate com o checksum', async () => {
  const original = Buffer.from('arquivo legado FACL em texto puro');
  const checksum = require('crypto').createHash('sha256').update(original).digest('hex');
  const make = (bytes) =>
    withTenantTransaction(tenant, (t) =>
      File.create(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          storageKey: diskStorage.saveFile('generic', tenant.groupId, 'legado-facl.pdf', bytes),
          fileName: 'legado-facl.pdf',
          mimeType: 'application/pdf',
          sizeBytes: original.length,
          checksumSha256: checksum,
          encryptedAtRest: false,
          uploadedByUserId: uploader.id,
          createdBy: uploader.id,
        },
        { transaction: t }
      )
    );

  const intact = await make(original);
  assert.equal((await get(`/files/${intact.id}/content`, uploader.id, [])).status, 200);

  const tampered = await make(Buffer.from('arquivo legado FACL ADULTERADO'));
  const res = await get(`/files/${tampered.id}/content`, uploader.id, []);
  assert.deepEqual([res.status, res.code], [409, 'FILE_INTEGRITY_VIOLATION']);
});

test('I4: upload novo nasce marcado como cifrado em repouso', async () => {
  const file = await upload(uploader.id);
  const stored = await withTenantTransaction(tenant, (t) => File.findByPk(file.id, { transaction: t }));
  assert.equal(stored.encryptedAtRest, true);
});

// I2 — cada TIPO de entidade mapeado em people.file_links dá exatamente a permissão do módulo
// dono; tipo não mapeado conta como "com dono" e não libera ninguém (fail closed). Tudo em
// transação com rollback: nada fica gravado.
test('I2: cada entityType de file_links mapeado dá só a leitura do próprio módulo; tipo desconhecido fecha', async () => {
  const types = { ...fileAccessService.FILE_LINK_ENTITY_PERMISSIONS, FACLDesconhecido: [] };
  const allPermissions = [...new Set(Object.values(fileAccessService.FILE_LINK_ENTITY_PERMISSIONS).flat()), 'finance:read'];
  for (const [entityType, expected] of Object.entries(types)) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const file = await File.create(
        {
          groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `contracts/${tenant.groupId}/facl-${uniqueSuffix()}.pdf`,
          fileName: 'facl.pdf', mimeType: 'application/pdf', sizeBytes: 1, uploadedByUserId: uploader.id, createdBy: uploader.id,
        },
        { transaction: t }
      );
      await sequelize.query(
        `INSERT INTO people.file_links (id, group_id, company_id, file_id, related_entity_type, related_entity_id, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :file, :type, gen_random_uuid(), now(), now())`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, file: file.id, type: entityType }, transaction: t }
      );
      const ownership = await fileAccessService.resolveFileOwnership(file.id, t);
      assert.equal(ownership.hasOwner, true, `${entityType}: vínculo conta como dono`);
      assert.deepEqual([...ownership.permissions].sort(), [...expected].sort(), `${entityType}: permissões`);
      for (const p of allPermissions) {
        const can = await fileAccessService.canReadFile(file, { userId: reader.id, permissions: [p] }, t);
        assert.equal(can, expected.includes(p), `${entityType} com ${p}`);
      }
      // categoria "contracts" do storageKey e o uploader não valem com dono
      assert.equal(await fileAccessService.canReadFile(file, { userId: uploader.id, permissions: [] }, t), false, `${entityType}: uploader`);
      if (!expected.includes('legal:read')) {
        assert.equal(await fileAccessService.canReadFile(file, { userId: reader.id, permissions: ['legal:read'] }, t), false, `${entityType}: categoria`);
      }
    });
  }
});

// I2 — toda coluna listada em FILE_REFERENCES existe com o tipo declarado (coluna renomeada ou
// tabela removida derrubaria a consulta de dono ou deixaria arquivo sem dono em silêncio).
test('I2: toda referência mapeada existe no banco com o tipo declarado', async () => {
  const expectedType = { uuid: 'uuid', uuid_array: 'ARRAY', jsonb_array: 'jsonb' };
  for (const ref of fileAccessService.FILE_REFERENCES) {
    const [schema, table] = ref.table.split('.');
    const [rows] = await sequelize.query(
      `SELECT data_type, udt_name FROM information_schema.columns WHERE table_schema = :schema AND table_name = :table AND column_name = :column`,
      { replacements: { schema, table, column: ref.column } }
    );
    assert.equal(rows.length, 1, `${ref.table}.${ref.column} existe`);
    assert.equal(rows[0].data_type, expectedType[ref.kind], `${ref.table}.${ref.column} é ${ref.kind}`);
    if (ref.kind === 'uuid_array') assert.equal(rows[0].udt_name, '_uuid');
    assert.ok(ref.permissions.length > 0);
  }
});
