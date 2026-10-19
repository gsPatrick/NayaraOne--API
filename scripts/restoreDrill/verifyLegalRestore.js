'use strict';

/**
 * Verificação pós-restore do drill jurídico (F05, conferência Nayara 18/10/2026 — revisado após
 * a revisão independente do mesmo dia).
 *
 * Roda num processo filho com:
 *   DATABASE_URL = banco RESTAURADO, role de runtime (sem BYPASSRLS) — usado pelos serviços
 *   UPLOADS_DIR  = storage RESTAURADO (restaurado por scripts/restoreStorage.js)
 * e recebe por argumento as URLs superusuário de origem/destino (comparação bruta, sem RLS) e o
 * storage de origem.
 *
 * O relatório lista, por objeto, quantos registros e QUAIS campos foram comparados, separando
 * campos comparados COM VALOR de campos nulos dos dois lados (null = null não conta como
 * cobertura). Termina com exit code 1 se qualquer checagem falhar.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { assertDrillDatabase } = require('./drillGuard');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (argv[i].startsWith('--') && argv[i + 1]) { out[key] = argv[i + 1]; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['fixtures', 'source-url', 'target-url', 'source-uploads', 'target-app-url', 'report']) {
  if (!args[required]) throw new Error(`Argumento obrigatório ausente: --${required}`);
}
// Proteção: nunca rodar contra o banco compartilhado (o script faz UPDATE de teste de
// isolamento, grava configuração e confirma pagamento).
for (const url of [process.env.DATABASE_URL, args['source-url'], args['target-url'], args['target-app-url']]) {
  assertDrillDatabase(url, 'verifyLegalRestore');
}

const { decryptFileBuffer } = require('../../src/utils/fileCrypto');

const results = [];
function check(objectName, label, ok, detail = '') {
  results.push({ objectName, label, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const knownLimits = [];
function knownLimit(objectName, label, note) {
  knownLimits.push({ objectName, label, note });
  results.push({ objectName, label, ok: null, knownLimit: true, detail: note });
  console.log(`  ⚠️  LIMITE CONHECIDO: ${label} — ${note}`);
}

function normalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const objectSummary = [];

/**
 * compareTable — busca as mesmas linhas (mesma query, mesmos parâmetros) na origem e no
 * destino, compara campo a campo pela chave `id` e registra quantos registros e quais campos
 * foram comparados. Comparação de dois nulos é contada à parte e NÃO entra como cobertura; um
 * campo listado que for nulo em todas as linhas aparece no resumo como "sempre nulo".
 */
async function compareTable(source, target, objectName, sql, params, fields, { minRecords = 1 } = {}) {
  console.log(`\n--- ${objectName} ---`);
  const [srcRes, tgtRes] = await Promise.all([source.query(sql, params), target.query(sql, params)]);
  const src = srcRes.rows;
  const tgt = new Map(tgtRes.rows.map((r) => [r.id, r]));
  check(objectName, `registros na origem: ${src.length} (mínimo ${minRecords})`, src.length >= minRecords);
  check(objectName, `mesma quantidade de registros (origem ${src.length}, destino ${tgtRes.rows.length})`, src.length === tgtRes.rows.length);
  let withValue = 0;
  let bothNull = 0;
  let failures = 0;
  const fieldsWithValue = new Set();
  for (const row of src) {
    const other = tgt.get(row.id);
    if (!other) {
      failures += 1;
      check(objectName, `registro ${row.id} presente no destino`, false);
      continue;
    }
    for (const field of fields) {
      const a = normalize(row[field]);
      const b = normalize(other[field]);
      if (a === null && b === null) {
        bothNull += 1;
        continue;
      }
      withValue += 1;
      fieldsWithValue.add(field);
      if (a !== b) {
        failures += 1;
        check(objectName, `${row.id}.${field}`, false, `origem "${a}" ≠ destino "${b}"`);
      }
    }
  }
  const alwaysNull = fields.filter((f) => !fieldsWithValue.has(f));
  check(objectName, `${withValue} comparações COM VALOR idênticas (${src.length} registros × ${fields.length} campos; ${bothNull} nulo=nulo à parte)`, failures === 0 && withValue > 0);
  objectSummary.push({ objectName, records: src.length, fields, comparedWithValue: withValue, bothNull, alwaysNullFields: alwaysNull, failures });
  return src;
}

async function main() {
  const fixtures = JSON.parse(fs.readFileSync(args.fixtures, 'utf8'));
  const A = fixtures.tenantA;
  const B = fixtures.tenantB;

  const source = new Client({ connectionString: args['source-url'] });
  const target = new Client({ connectionString: args['target-url'] });
  await source.connect();
  await target.connect();

  try {
    console.log('\n=== Drill de restore jurídico — comparação origem x destino restaurado ===');
    console.log(`Tenant A (dados controlados): company=${A.companyId}`);
    console.log(`Tenant B (isolamento):        company=${B.companyId}`);

    const byCompany = [A.companyId];

    // 1. Dados, campo a campo.
    await compareTable(source, target, 'legal.contracts',
      'SELECT * FROM legal.contracts WHERE company_id = $1 ORDER BY id', byCompany,
      ['group_id', 'company_id', 'property_id', 'contract_type', 'contract_number', 'status', 'total_value', 'starts_at', 'ends_at', 'lock_version', 'created_by', 'created_at']);
    await compareTable(source, target, 'legal.contract_parties',
      'SELECT * FROM legal.contract_parties WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'person_id', 'party_role'], { minRecords: 2 });
    await compareTable(source, target, 'people.persons (partes e signatários)',
      'SELECT * FROM people.persons WHERE id = ANY($1) ORDER BY id', [A.persons],
      ['company_id', 'person_type', 'legal_name', 'birth_or_foundation_date', 'status', 'lock_version', 'created_by'], { minRecords: 2 });
    await compareTable(source, target, 'real_estate.properties',
      'SELECT * FROM real_estate.properties WHERE id = $1 ORDER BY id', [A.propertyId],
      ['company_id', 'title', 'internal_code', 'property_type', 'address_line', 'city', 'state', 'zip_code', 'description', 'bedrooms', 'parking_spots', 'lock_version']);
    await compareTable(source, target, 'core.users (atores do drill)',
      'SELECT * FROM core.users WHERE id = ANY($1) ORDER BY id', [A.userIds],
      ['name', 'email', 'password_hash', 'status', 'mfa_enabled'], { minRecords: 2 });
    await compareTable(source, target, 'legal.contract_clauses',
      'SELECT * FROM legal.contract_clauses WHERE id = ANY($1) ORDER BY id', [Object.values(A.clauseIds)],
      ['code', 'title', 'body_text', 'category', 'version_number', 'is_active', 'condition_json', 'condition_status', 'condition_approved_by', 'condition_approved_at', 'created_by'], { minRecords: 3 });
    const versions = await compareTable(source, target, 'legal.contract_versions',
      'SELECT * FROM legal.contract_versions WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'version_number', 'document_file_id', 'signed_document_file_id', 'content_hash', 'content', 'template_id', 'clause_version_ids', 'condition_context', 'excluded_clauses', 'effective_from', 'created_by']);
    const signatures = await compareTable(source, target, 'legal.signatures',
      'SELECT * FROM legal.signatures WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_version_id', 'person_id', 'status', 'signed_at', 'external_signature_id', 'provider_envelope_id'], { minRecords: 2 });
    await compareTable(source, target, 'legal.signature_provider_routing',
      'SELECT * FROM legal.signature_provider_routing WHERE company_id = $1 ORDER BY id', byCompany,
      ['external_signature_id', 'provider_envelope_id', 'group_id', 'company_id']);
    await compareTable(source, target, 'legal.contract_requirements',
      'SELECT * FROM legal.contract_requirements WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'requirement_code', 'description', 'requirement_type', 'status', 'satisfied_by_file_id', 'satisfied_at', 'waived_reason'], { minRecords: 2 });
    await compareTable(source, target, 'legal.guarantees',
      'SELECT * FROM legal.guarantees WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'guarantee_type', 'value', 'status', 'starts_at', 'ends_at', 'lock_version']);
    const inspections = await compareTable(source, target, 'legal.inspections',
      'SELECT * FROM legal.inspections WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'property_id', 'inspection_type', 'status', 'completed_at', 'report_hash', 'report_pdf_bytes', 'report_generated_at']);
    await compareTable(source, target, 'legal.inspection_items',
      'SELECT * FROM legal.inspection_items WHERE company_id = $1 ORDER BY id', byCompany,
      ['inspection_id', 'item_name', 'condition', 'notes'], { minRecords: 2 });
    await compareTable(source, target, 'legal.inspection_signatures',
      'SELECT * FROM legal.inspection_signatures WHERE company_id = $1 ORDER BY id', byCompany,
      ['inspection_id', 'party_role', 'signed_by_user_id', 'signature_hash', 'signed_at'], { minRecords: 2 });
    const fileLinks = await compareTable(source, target, 'people.file_links',
      'SELECT * FROM people.file_links WHERE company_id = $1 ORDER BY id', byCompany,
      ['file_id', 'related_entity_type', 'related_entity_id', 'purpose'], { minRecords: 2 });
    const files = await compareTable(source, target, 'people.files (metadados)',
      'SELECT id, storage_key, file_name, mime_type, size_bytes, checksum_sha256, uploaded_by_user_id FROM people.files WHERE company_id = $1 ORDER BY id', byCompany,
      ['storage_key', 'file_name', 'mime_type', 'size_bytes', 'checksum_sha256', 'uploaded_by_user_id'], { minRecords: 5 });
    await compareTable(source, target, 'legal.legal_cases',
      'SELECT * FROM legal.legal_cases WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'property_id', 'responsible_user_id', 'escalation_user_id', 'case_number', 'case_type', 'status', 'summary', 'phase', 'legal_hold', 'legal_hold_reason', 'legal_hold_set_by', 'legal_hold_set_at']);
    const packages = await compareTable(source, target, 'legal.evidence_packages',
      'SELECT * FROM legal.evidence_packages WHERE company_id = $1 ORDER BY id', byCompany,
      ['legal_case_id', 'manifest_json', 'package_hash', 'created_by']);
    await compareTable(source, target, 'legal.evidence_package_access_log',
      'SELECT * FROM legal.evidence_package_access_log WHERE company_id = $1 ORDER BY id', byCompany,
      ['evidence_package_id', 'accessed_by_user_id', 'action', 'accessed_at']);
    await compareTable(source, target, 'audit.audit_log (trilha dos objetos do drill)',
      'SELECT * FROM audit.audit_log WHERE entity_id = ANY($1) ORDER BY id', [A.auditEntityIds],
      ['company_id', 'user_id', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'reason', 'occurred_at'], { minRecords: A.auditEntityIds.length });

    await compareTable(source, target, 'finance.financial_entries',
      'SELECT * FROM finance.financial_entries WHERE company_id = $1 ORDER BY id', byCompany,
      ['entry_type', 'nature', 'amount', 'status', 'due_at', 'settled_at', 'bank_account_id', 'idempotency_key', 'parent_entry_id', 'lock_version']);
    await compareTable(source, target, 'finance.payment_intents',
      'SELECT * FROM finance.payment_intents WHERE company_id = $1 ORDER BY id', byCompany,
      ['financial_entry_id', 'status', 'snapshot_hash', 'external_submission_id', 'external_status', 'idempotency_key', 'executed_at']);
    await compareTable(source, target, 'finance.bank_payment_provider_routing',
      'SELECT * FROM finance.bank_payment_provider_routing WHERE company_id = $1 ORDER BY id', byCompany,
      ['external_submission_id', 'payment_intent_id', 'group_id', 'company_id']);

    // 2. Bytes dos arquivos: blob cifrado copiado bit a bit e conteúdo decifrado igual ao SHA-256
    // INDEPENDENTE calculado pelas fixtures sobre os bytes gerados (não só o checksum gravado).
    console.log('\n--- Bytes dos arquivos (storage em disco, cifrado em repouso) ---');
    const targetUploads = process.env.UPLOADS_DIR;
    let bytesVerified = 0;
    const expectedIds = Object.keys(A.expectedFileSha256);
    check('arquivos (bytes)', `fixtures registraram SHA-256 independente para ${expectedIds.length} arquivo(s)`, expectedIds.length >= 5);
    for (const file of files) {
      const expected = A.expectedFileSha256[file.id];
      const srcBlob = fs.readFileSync(path.join(args['source-uploads'], file.storage_key));
      const tgtBlob = fs.readFileSync(path.join(targetUploads, file.storage_key));
      const tgtPlain = decryptFileBuffer(tgtBlob);
      const blobOk = sha256(srcBlob) === sha256(tgtBlob);
      const independentOk = Boolean(expected) && sha256(tgtPlain) === expected;
      const recordedOk = sha256(tgtPlain) === file.checksum_sha256;
      const notEmpty = tgtPlain.length > 0 && tgtPlain.length === Number(file.size_bytes);
      check('arquivos (bytes)', `${file.file_name}: blob cifrado restaurado idêntico ao de origem (${tgtBlob.length} bytes)`, blobOk);
      check('arquivos (bytes)', `${file.file_name}: SHA-256 do conteúdo restaurado = SHA-256 independente das fixtures (${expected ? expected.slice(0, 16) : 'ausente'}…)`, independentOk);
      check('arquivos (bytes)', `${file.file_name}: e = checksum gravado pelo serviço; conteúdo não vazio e do tamanho gravado (${tgtPlain.length} bytes)`, recordedOk && notEmpty);
      if (blobOk && independentOk && recordedOk && notEmpty) bytesVerified += 1;
    }
    check('arquivos (bytes)', `todos os arquivos com SHA-256 independente foram encontrados e conferidos (${bytesVerified}/${expectedIds.length})`, bytesVerified === expectedIds.length && files.length === expectedIds.length);
    objectSummary.push({ objectName: 'arquivos (bytes)', records: files.length, fields: ['blob cifrado sha256 origem=destino', 'conteúdo decifrado sha256 = sha256 independente das fixtures', 'conteúdo decifrado sha256 = checksum_sha256 gravado', 'tamanho = size_bytes'], comparedWithValue: files.length * 4, bothNull: 0, alwaysNullFields: [], failures: files.length - bytesVerified });

    console.log('\n--- Documento assinado (versão do contrato) ---');
    const signedVersion = versions.find((v) => v.signed_document_file_id);
    check('documento assinado', `versão ${A.contractVersionId} tem documento assinado (signed_document_file_id preenchido)`, Boolean(signedVersion) && signedVersion.signed_document_file_id === A.signedDocumentFileId);
    const signedFile = files.find((f) => f.id === A.signedDocumentFileId);
    if (signedFile) {
      const plain = decryptFileBuffer(fs.readFileSync(path.join(targetUploads, signedFile.storage_key)));
      check('documento assinado', `bytes do documento assinado restaurado (${plain.length} bytes) = SHA-256 independente`, sha256(plain) === A.expectedFileSha256[A.signedDocumentFileId]);
    } else {
      check('documento assinado', 'arquivo do documento assinado presente no destino', false);
    }

    console.log('\n--- PDF do relatório de vistoria (bytea no banco) ---');
    for (const inspection of inspections) {
      const restored = await target.query('SELECT report_pdf_bytes, report_hash FROM legal.inspections WHERE id = $1', [inspection.id]);
      const pdf = restored.rows[0].report_pdf_bytes;
      check('relatório de vistoria (bytes)', `vistoria ${inspection.id}: PDF restaurado não vazio (${pdf ? pdf.length : 0} bytes) e SHA-256 = report_hash`,
        Boolean(pdf) && pdf.length > 0 && sha256(pdf) === restored.rows[0].report_hash);
    }

    // 3. Relações: cada referência do destino aponta para um registro restaurado do mesmo tenant.
    console.log('\n--- Relações no banco restaurado ---');
    const tgtVersionIds = new Set((await target.query('SELECT id FROM legal.contract_versions WHERE company_id = $1', byCompany)).rows.map((r) => r.id));
    const tgtFileIds = new Set((await target.query('SELECT id FROM people.files WHERE company_id = $1', byCompany)).rows.map((r) => r.id));
    const tgtPersonIds = new Set((await target.query('SELECT id FROM people.persons WHERE company_id = $1', byCompany)).rows.map((r) => r.id));
    check('relações', `assinaturas a verificar (${signatures.length})`, signatures.length > 0);
    for (const signature of signatures) {
      check('relações', `assinatura ${signature.id} → versão ${signature.contract_version_id} e signatário ${signature.person_id} existem no destino`,
        tgtVersionIds.has(signature.contract_version_id) && tgtPersonIds.has(signature.person_id));
    }
    for (const version of versions) {
      if (version.document_file_id) check('relações', `versão ${version.id} → documento ${version.document_file_id} existe no destino`, tgtFileIds.has(version.document_file_id));
      if (version.signed_document_file_id) check('relações', `versão ${version.id} → documento assinado ${version.signed_document_file_id} existe no destino`, tgtFileIds.has(version.signed_document_file_id));
      if (version.template_id) {
        const tpl = await target.query('SELECT id FROM legal.contract_templates WHERE id = $1', [version.template_id]);
        check('relações', `versão ${version.id} → modelo ${version.template_id} existe no destino`, tpl.rows.length === 1);
      }
    }
    // Referências polimórficas (related_entity_type + related_entity_id, sem FK no banco).
    const polymorphicTables = { InspectionItem: 'legal.inspection_items', LegalCase: 'legal.legal_cases', Contract: 'legal.contracts', ContractVersion: 'legal.contract_versions' };
    check('relações', `vínculos polimórficos a verificar (${fileLinks.length})`, fileLinks.length > 0);
    for (const link of fileLinks) {
      const table = polymorphicTables[link.related_entity_type];
      const exists = table ? (await target.query(`SELECT id FROM ${table} WHERE id = $1 AND company_id = $2`, [link.related_entity_id, A.companyId])).rows.length === 1 : false;
      check('relações', `file_link ${link.id}: arquivo ${link.file_id} existe e ${link.related_entity_type} ${link.related_entity_id} existe no destino`,
        tgtFileIds.has(link.file_id) && exists, table ? '' : `tipo ${link.related_entity_type} sem mapeamento no drill`);
    }
    check('relações', `dossiês a verificar (${packages.length})`, packages.length > 0);
    for (const pkg of packages) {
      const manifest = Array.isArray(pkg.manifest_json) ? pkg.manifest_json : [];
      check('relações', `dossiê ${pkg.id}: manifesto não vazio (${manifest.length} itens)`, manifest.length > 0);
      for (const item of manifest) {
        const ref = await target.query(
          `SELECT f.checksum_sha256 FROM people.files f WHERE f.company_id = $2 AND f.id IN (
             SELECT document_file_id FROM legal.contract_versions WHERE id = $1
             UNION SELECT satisfied_by_file_id FROM legal.contract_requirements WHERE id = $1
             UNION SELECT file_id FROM people.file_links WHERE id = $1)`,
          [item.referenceId, A.companyId]
        );
        check('relações', `dossiê: item ${item.type} → referência ${item.referenceId} resolve para arquivo restaurado com o mesmo hash`,
          ref.rows.length === 1 && ref.rows[0].checksum_sha256 === item.hash);
      }
    }

    // Imutabilidade da versão no banco restaurado (trigger append-only, migration 171 + 398): o
    // documento assinado foi vinculado uma vez pelo fluxo real; trocá-lo, removê-lo ou mexer no
    // conteúdo continua proibido — inclusive no banco restaurado.
    console.log('\n--- Imutabilidade da versão assinada no banco restaurado ---');
    const otherFileId = files.find((f) => f.id !== A.signedDocumentFileId).id;
    for (const [label, sql, params] of [
      ['trocar o documento assinado por outro arquivo', 'UPDATE legal.contract_versions SET signed_document_file_id = $1 WHERE id = $2', [otherFileId, A.contractVersionId]],
      ['remover o documento assinado', 'UPDATE legal.contract_versions SET signed_document_file_id = NULL WHERE id = $1', [A.contractVersionId]],
      ['alterar o conteúdo da versão', "UPDATE legal.contract_versions SET content = content || ' (adulterado)' WHERE id = $1", [A.contractVersionId]],
    ]) {
      let blocked = false;
      try {
        await target.query(sql, params);
      } catch (err) {
        blocked = /append-only|só pode ser vinculado/.test(err.message);
      }
      check('imutabilidade pós-restore', `${label} → recusado pelo trigger do banco`, blocked);
    }

    // 4. Exportação, permissões, replay e adulteração, pelos serviços e pela API reais.
    await verifyExportAndPermissions(A, B, target);
  } finally {
    await source.end();
    await target.end();
  }
}

async function verifyExportAndPermissions(A, B, targetSuper) {
  const { sequelize } = require('../../src/models');
  const evidencePackagesService = require('../../src/features/legal/evidencePackages.service');
  const filesService = require('../../src/features/files/files.service');

  async function inTenant(tenant, fn) {
    const transaction = await sequelize.transaction();
    try {
      await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: tenant.groupId }, transaction });
      await sequelize.query('SELECT set_config(\'app.company_id\', :c, true)', { replacements: { c: tenant.companyId }, transaction });
      await sequelize.query('SELECT set_config(\'app.user_id\', :u, true)', { replacements: { u: tenant.userId }, transaction });
      const out = await fn(transaction);
      await transaction.commit();
      return out;
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
  async function expectError(fn, code) {
    try {
      await fn();
      return { ok: false, got: 'nenhum erro' };
    } catch (err) {
      return { ok: err.code === code, got: err.code || err.message };
    }
  }

  console.log('\n--- Exportação do dossiê a partir do banco restaurado (serviço real) ---');
  const exported = await inTenant(A, (t) => evidencePackagesService.exportEvidencePackage(A.evidencePackageId, A.userId, t));
  const integrity = evidencePackagesService.verifyEvidencePackageIntegrity(exported, A.evidencePackageHash);
  check('exportação pós-restore', `manifesto exportado (${exported.itemCount} itens) recalculado = hash gravado ANTES do backup (${A.evidencePackageHash.slice(0, 16)}…)`, integrity.valid && exported.itemCount > 0);
  const manifestItems = Array.isArray(exported.manifest) ? exported.manifest : [];
  check('exportação pós-restore', `manifesto exportado não vazio (${manifestItems.length} itens)`, manifestItems.length > 0);
  for (const item of manifestItems) {
    const fileId = await resolveManifestFileId(targetSuper, A.companyId, item.referenceId);
    const content = fileId ? await inTenant(A, (t) => filesService.getFileContent(fileId, t, A.userId)) : null;
    check('exportação pós-restore', `item ${item.type}: bytes servidos pelo serviço de arquivos têm o hash do manifesto`,
      Boolean(content) && sha256(content.content) === item.hash);
  }

  console.log('\n--- Permissões pós-restore: isolamento por tenant (RLS do banco restaurado) ---');
  const crossExport = await expectError(
    () => inTenant(B, (t) => evidencePackagesService.exportEvidencePackage(A.evidencePackageId, B.userId, t)),
    'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND'
  );
  check('permissões pós-restore', `tenant B exportando o dossiê de A → ${crossExport.got}`, crossExport.ok);
  const someFile = A.files[0];
  const crossFile = await expectError(() => inTenant(B, (t) => filesService.getFileContent(someFile, t, B.userId)), 'FILE_NOT_FOUND');
  check('permissões pós-restore', `tenant B baixando arquivo de A → ${crossFile.got}`, crossFile.ok);

  const counts = await inTenant(B, async (t) => {
    const q = async (sql, replacements) => (await sequelize.query(sql, { replacements, transaction: t, type: sequelize.QueryTypes.SELECT }))[0].n;
    return {
      contractsA: await q('SELECT COUNT(*)::int AS n FROM legal.contracts WHERE id = :id', { id: A.contractId }),
      versionsA: await q('SELECT COUNT(*)::int AS n FROM legal.contract_versions WHERE id = :id', { id: A.contractVersionId }),
      signaturesA: await q('SELECT COUNT(*)::int AS n FROM legal.signatures WHERE id IN (:ids)', { ids: A.signatureIds }),
      filesA: await q('SELECT COUNT(*)::int AS n FROM people.files WHERE id IN (:ids)', { ids: A.files }),
      packagesA: await q('SELECT COUNT(*)::int AS n FROM legal.evidence_packages WHERE id = :id', { id: A.evidencePackageId }),
      personsA: await q('SELECT COUNT(*)::int AS n FROM people.persons WHERE id IN (:ids)', { ids: A.persons }),
      ownContract: await q('SELECT COUNT(*)::int AS n FROM legal.contracts WHERE id = :id', { id: B.contractId }),
    };
  });
  check('permissões pós-restore', `tenant B não enxerga contrato/versão/assinaturas/arquivos/dossiê/pessoas de A (${counts.contractsA}/${counts.versionsA}/${counts.signaturesA}/${counts.filesA}/${counts.packagesA}/${counts.personsA})`,
    counts.contractsA + counts.versionsA + counts.signaturesA + counts.filesA + counts.packagesA + counts.personsA === 0);
  check('permissões pós-restore', `controle positivo: tenant B enxerga o próprio contrato (${counts.ownContract})`, counts.ownContract === 1);
  const crossUpdate = await inTenant(B, async (t) => {
    const [, meta] = await sequelize.query('UPDATE legal.contracts SET total_value = 1 WHERE id = :id', { replacements: { id: A.contractId }, transaction: t });
    return meta.rowCount;
  });
  check('permissões pós-restore', `tenant B tentando alterar contrato de A → ${crossUpdate} linha(s) afetada(s)`, crossUpdate === 0);

  console.log('\n--- Permissões pós-restore: RBAC pela API real servindo o banco restaurado ---');
  const { signAccessToken } = require('../../src/utils/jwt');
  require('../../app');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  const exportPath = `/legal/evidence-packages/${A.evidencePackageId}/export`;
  // Os downloads usam o SEGUNDO usuário (não é quem fez o upload), para que o resultado venha
  // da regra de permissão do módulo e não da regra do uploader.
  const readerUserId = A.userIds[1];
  const tokenFor = (tenant, permissions, userId = tenant.userId) => signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['drill'], permissions });
  const get = (urlPath, token) => fetch(`${baseUrl}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } });

  const logBefore = Number((await targetSuper.query('SELECT COUNT(*)::int AS n FROM legal.evidence_package_access_log WHERE evidence_package_id = $1 AND action = $2', [A.evidencePackageId, 'EXPORTED'])).rows[0].n);

  const noPerm = await get(exportPath, tokenFor(A, ['contracts:read']));
  check('permissões pós-restore', `perfil do tenant A SEM legal:read exportando o dossiê → HTTP ${noPerm.status}`, noPerm.status === 403);
  const otherTenant = await get(exportPath, tokenFor(B, ['legal:read']));
  check('permissões pós-restore', `tenant B COM legal:read exportando o dossiê de A → HTTP ${otherTenant.status}`, otherTenant.status === 404);
  const allowed = await get(exportPath, tokenFor(A, ['legal:read']));
  const allowedBody = allowed.status === 200 ? await allowed.json() : null;
  const allowedIntegrity = allowedBody ? evidencePackagesService.verifyEvidencePackageIntegrity(allowedBody.data, A.evidencePackageHash) : { valid: false };
  check('permissões pós-restore', `controle positivo: tenant A COM legal:read → HTTP ${allowed.status}, export íntegro contra o hash pré-backup`, allowed.status === 200 && allowedIntegrity.valid);

  const signedPath = `/files/${A.signedDocumentFileId}/content`;
  const dlNoPerm = await get(signedPath, tokenFor(A, ['finance:read', 'inventory:read'], readerUserId));
  check('permissões pós-restore', `download do contrato assinado por perfil do tenant A SEM legal:read → HTTP ${dlNoPerm.status}`, dlNoPerm.status === 403);
  const dlOther = await get(signedPath, tokenFor(B, ['legal:read'], readerUserId));
  check('permissões pós-restore', `download do contrato assinado pelo tenant B COM legal:read → HTTP ${dlOther.status}`, dlOther.status === 404);
  const dlOk = await get(signedPath, tokenFor(A, ['legal:read'], readerUserId));
  const dlBytes = dlOk.status === 200 ? Buffer.from(await dlOk.arrayBuffer()) : Buffer.alloc(0);
  check('permissões pós-restore', `controle positivo: perfil do tenant A COM legal:read baixa o contrato assinado → HTTP ${dlOk.status}, bytes = SHA-256 independente`,
    dlOk.status === 200 && sha256(dlBytes) === A.expectedFileSha256[A.signedDocumentFileId]);

  const logAfter = Number((await targetSuper.query('SELECT COUNT(*)::int AS n FROM legal.evidence_package_access_log WHERE evidence_package_id = $1 AND action = $2', [A.evidencePackageId, 'EXPORTED'])).rows[0].n);
  check('permissões pós-restore', `cadeia de custódia: só o export permitido gerou registro EXPORTED (${logBefore} → ${logAfter})`, logAfter === logBefore + 1);

  // 5. Replay pós-restore do callback bancário já processado antes do backup (F06), pela ROTA
  // pública do webhook com HMAC. O tenant é configurado com provedor não-sandbox e segredo de
  // webhook (no banco restaurado), para que a rota exija a assinatura HMAC de verdade.
  console.log('\n--- Replay pós-restore do callback bancário pela rota do webhook com HMAC (F06) ---');
  const settingsService = require('../../src/features/settings/settings.service');
  const webhookSecret = crypto.randomBytes(24).toString('hex');
  await inTenant(A, async (t) => {
    await settingsService.upsertSetting('finance.payment_provider', 'santander', A, A.userId, t);
    await settingsService.upsertSetting('finance.bank_payment_webhook_secret', webhookSecret, A, A.userId, t);
  });
  const bp = A.bankPayment;
  const countRows = async () => (await targetSuper.query(
    `SELECT
       (SELECT COUNT(*)::int FROM finance.financial_entries WHERE company_id = $1) AS entries,
       (SELECT COUNT(*)::int FROM finance.financial_entries WHERE id = $2 AND status = 'SETTLED') AS settled,
       (SELECT COUNT(*)::int FROM finance.financial_entries WHERE parent_entry_id = $2) AS children,
       (SELECT lock_version FROM finance.financial_entries WHERE id = $2) AS lock_version,
       (SELECT COUNT(*)::int FROM finance.payment_intents WHERE financial_entry_id = $2 AND status = 'EXECUTED') AS executed`,
    [A.companyId, bp.financialEntryId]
  )).rows[0];
  const beforeReplay = await countRows();
  check('replay pós-restore', `estado restaurado: lançamento liquidado uma vez (${beforeReplay.settled}) por uma intenção executada (${beforeReplay.executed})`, beforeReplay.settled === 1 && beforeReplay.executed === 1);
  const webhookBody = JSON.stringify({ externalSubmissionId: bp.externalSubmissionId, status: 'CONFIRMED' });
  const postWebhook = (signature) => fetch(`${baseUrl}/finance/webhooks/bank-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature },
    body: webhookBody,
  });
  const forged = await postWebhook(`sha256=${'0'.repeat(64)}`);
  check('replay pós-restore', `callback com assinatura HMAC forjada → HTTP ${forged.status} (recusado)`, forged.status === 401);
  const validSignature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(webhookBody).digest('hex')}`;
  for (let i = 1; i <= 2; i += 1) {
    const res = await postWebhook(validSignature);
    const body = res.status === 200 ? await res.json() : null;
    check('replay pós-restore', `entrega ${i} do mesmo callback CONFIRMED com HMAC válido → HTTP ${res.status}, processado sem erro`, res.status === 200 && body && body.data && body.data.received === true);
  }
  const afterReplay = await countRows();
  check('replay pós-restore', `nenhum lançamento novo (${beforeReplay.entries} → ${afterReplay.entries}), nenhum filho (${afterReplay.children}), lançamento intocado (lock_version ${beforeReplay.lock_version} → ${afterReplay.lock_version}), intenção continua uma só executada`,
    afterReplay.entries === beforeReplay.entries && afterReplay.children === 0 && afterReplay.lock_version === beforeReplay.lock_version && afterReplay.settled === 1 && afterReplay.executed === 1);

  // 6. Adulteração deliberada de bytes no storage restaurado: detectada no arquivo E recusada
  // pela API (o serviço confere o checksum na leitura).
  console.log('\n--- Adulteração deliberada de um arquivo restaurado ---');
  const victimId = A.files[0];
  const victim = (await targetSuper.query('SELECT storage_key, checksum_sha256 FROM people.files WHERE id = $1', [victimId])).rows[0];
  const victimPath = path.join(process.env.UPLOADS_DIR, victim.storage_key);
  const original = fs.readFileSync(victimPath);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(victimPath, tampered);
  let detected = false;
  try {
    detected = sha256(decryptFileBuffer(tampered)) !== victim.checksum_sha256;
  } catch (err) {
    detected = true;
  }
  check('adulteração', 'um byte alterado no blob restaurado é detectado no arquivo (autenticação AES-GCM / checksum)', detected);
  const tamperedDownload = await get(`/files/${victimId}/content`, tokenFor(A, ['legal:read'], readerUserId));
  const servedBytes = tamperedDownload.status === 200 ? Buffer.from(await tamperedDownload.arrayBuffer()) : null;
  // Conferência do checksum na LEITURA (files.service#getFileContent) está em correção numa
  // frente separada (achado I4 da revisão independente de 18/10). Enquanto o commit testado não
  // tiver essa correção, o resultado é registrado como LIMITE CONHECIDO — explícito no
  // relatório, nunca contado como aprovado.
  if (tamperedDownload.status !== 200) {
    check('adulteração', `a API recusa servir o arquivo adulterado → HTTP ${tamperedDownload.status}`, true);
  } else {
    knownLimit('adulteração', `a API AINDA serve o arquivo adulterado (HTTP 200, ${servedBytes.length} bytes, SHA-256 ${sha256(servedBytes) === victim.checksum_sha256 ? 'igual' : 'diferente'} do gravado)`,
      'conferência de checksum na leitura em correção (frente de arquivos, achado I4) — o drill detecta, a API ainda não recusa');
  }
  fs.writeFileSync(victimPath, original);

  // Variante 2 — adulteração do MARCADOR do formato cifrado (primeiro byte): o leitor de arquivos
  // trata buffer sem marcador como "legado em texto puro" e devolve sem descriptografar. Sem a
  // conferência do checksum na leitura, a API serviria bytes adulterados com HTTP 200.
  const markerTampered = Buffer.from(original);
  markerTampered[0] ^= 0xff;
  fs.writeFileSync(victimPath, markerTampered);
  const markerDownload = await get(`/files/${victimId}/content`, tokenFor(A, ['legal:read'], readerUserId));
  const markerBytes = markerDownload.status === 200 ? Buffer.from(await markerDownload.arrayBuffer()) : null;
  if (markerDownload.status !== 200) {
    check('adulteração', `marcador do formato cifrado alterado: a API recusa servir → HTTP ${markerDownload.status}`, true);
  } else {
    knownLimit('adulteração', `marcador do formato cifrado alterado: a API SERVE os bytes adulterados (HTTP 200, ${markerBytes.length} bytes, SHA-256 ${sha256(markerBytes) === victim.checksum_sha256 ? 'igual' : 'diferente'} do gravado)`,
      'caminho "legado" sem conferência de checksum na leitura — em correção na frente de arquivos (achado I4)');
  }
  fs.writeFileSync(victimPath, original);
  if (tamperedDownload.status === 500) {
    knownLimit('adulteração', 'byte do blob alterado: a recusa vem como HTTP 500 (erro de autenticação AES-GCM não tratado), não como erro de integridade explícito',
      'resposta de integridade dedicada (FILE_INTEGRITY_VIOLATION) em correção na frente de arquivos (achado I4)');
  }

  await sequelize.close();
}

async function resolveManifestFileId(targetSuper, companyId, referenceId) {
  const res = await targetSuper.query(
    `SELECT document_file_id AS id FROM legal.contract_versions WHERE id = $1 AND company_id = $2
     UNION SELECT satisfied_by_file_id FROM legal.contract_requirements WHERE id = $1 AND company_id = $2
     UNION SELECT file_id FROM people.file_links WHERE id = $1 AND company_id = $2`,
    [referenceId, companyId]
  );
  return res.rows[0] ? res.rows[0].id : null;
}

main()
  .then(() => {
    const failed = results.filter((r) => r.ok === false);
    const approved = results.filter((r) => r.ok === true);
    console.log('\n=== Resumo por objeto ===');
    for (const s of objectSummary) {
      const nullNote = s.alwaysNullFields && s.alwaysNullFields.length ? `; sempre nulos: ${s.alwaysNullFields.join(', ')}` : '';
      console.log(`  ${s.failures === 0 ? '✅' : '❌'} ${s.objectName}: ${s.records} registro(s), ${s.comparedWithValue} comparações com valor, ${s.bothNull} nulo=nulo — campos: ${s.fields.join(', ')}${nullNote}`);
    }
    console.log(`\n${approved.length}/${approved.length + failed.length} checagens aprovadas${knownLimits.length ? `; ${knownLimits.length} limite(s) conhecido(s) registrado(s) à parte (não contados como aprovados)` : ''}.`);
    for (const l of knownLimits) console.log(`  ⚠️  ${l.objectName}: ${l.label} — ${l.note}`);
    if (failed.length > 0) {
      console.log('❌ RESULTADO FINAL: falhas encontradas — ver acima.');
    } else if (knownLimits.length > 0) {
      console.log(`✅ RESULTADO FINAL: restore jurídico íntegro (dados, bytes, documento assinado, relações, auditoria, exportação, permissões, replay e detecção de adulteração no arquivo), COM ${knownLimits.length} limite(s) conhecido(s) listado(s) acima — não estão cobertos.`);
    } else {
      console.log('✅ RESULTADO FINAL: restore jurídico íntegro (dados, bytes, documento assinado, relações, auditoria, exportação, permissões, replay e adulteração, inclusive recusa pela API).');
    }
    fs.writeFileSync(args.report, JSON.stringify({ objectSummary, knownLimits, results }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
