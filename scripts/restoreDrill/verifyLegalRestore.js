'use strict';

/**
 * Verificação pós-restore do drill jurídico (F05, conferência Nayara 18/10/2026).
 *
 * Roda num processo filho com:
 *   DATABASE_URL = banco RESTAURADO, role de runtime (sem BYPASSRLS) — usado pelos serviços
 *   UPLOADS_DIR  = storage RESTAURADO (cópia do backup de arquivos)
 * e recebe por argumento as URLs superusuário de origem/destino (comparação bruta, sem RLS) e o
 * storage de origem.
 *
 * O relatório lista, por objeto, quantos registros e QUAIS campos foram comparados — nada de
 * contagem agregada. Termina com exit code 1 se qualquer checagem falhar.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

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

const { decryptFileBuffer } = require('../../src/utils/fileCrypto');

const results = [];
function check(objectName, label, ok, detail = '') {
  results.push({ objectName, label, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function normalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const objectSummary = [];

/**
 * compareTable — busca as mesmas linhas (mesma query, mesmos parâmetros) na origem e no
 * destino, compara campo a campo pela chave `id` e registra no resumo quantos registros e
 * quais campos foram efetivamente comparados.
 */
async function compareTable(source, target, objectName, sql, params, fields) {
  console.log(`\n--- ${objectName} ---`);
  const [srcRes, tgtRes] = await Promise.all([source.query(sql, params), target.query(sql, params)]);
  const src = srcRes.rows;
  const tgt = new Map(tgtRes.rows.map((r) => [r.id, r]));
  check(objectName, `registros não vazios na origem (${src.length})`, src.length > 0);
  check(objectName, `mesma quantidade de registros (origem ${src.length}, destino ${tgtRes.rows.length})`, src.length === tgtRes.rows.length);
  let fieldChecks = 0;
  let fieldFailures = 0;
  for (const row of src) {
    const other = tgt.get(row.id);
    if (!other) {
      fieldFailures += 1;
      check(objectName, `registro ${row.id} presente no destino`, false);
      continue;
    }
    for (const field of fields) {
      fieldChecks += 1;
      const a = normalize(row[field]);
      const b = normalize(other[field]);
      if (a !== b) {
        fieldFailures += 1;
        check(objectName, `${row.id}.${field}`, false, `origem "${a}" ≠ destino "${b}"`);
      }
    }
  }
  check(objectName, `${fieldChecks} comparações campo a campo (${src.length} registros × ${fields.length} campos)`, fieldFailures === 0);
  objectSummary.push({ objectName, records: src.length, fields, fieldChecks, fieldFailures });
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

    // 1. Dados e relações, campo a campo.
    await compareTable(source, target, 'legal.contracts',
      'SELECT * FROM legal.contracts WHERE company_id = $1 ORDER BY id', byCompany,
      ['group_id', 'company_id', 'contract_type', 'contract_number', 'status', 'total_value', 'starts_at', 'ends_at', 'lock_version', 'created_at']);
    await compareTable(source, target, 'legal.contract_parties',
      'SELECT * FROM legal.contract_parties WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'person_id', 'party_role']);
    const versions = await compareTable(source, target, 'legal.contract_versions',
      'SELECT * FROM legal.contract_versions WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'version_number', 'document_file_id', 'signed_document_file_id', 'content_hash', 'content', 'template_id', 'clause_version_ids', 'effective_from']);
    const signatures = await compareTable(source, target, 'legal.signatures',
      'SELECT * FROM legal.signatures WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_version_id', 'person_id', 'status', 'signed_at', 'external_signature_id', 'provider_envelope_id']);
    await compareTable(source, target, 'legal.signature_provider_routing',
      'SELECT * FROM legal.signature_provider_routing WHERE company_id = $1 ORDER BY id', byCompany,
      ['external_signature_id', 'provider_envelope_id', 'group_id', 'company_id']);
    await compareTable(source, target, 'legal.contract_requirements',
      'SELECT * FROM legal.contract_requirements WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'requirement_code', 'requirement_type', 'status', 'satisfied_by_file_id', 'waived_reason']);
    const inspections = await compareTable(source, target, 'legal.inspections',
      'SELECT * FROM legal.inspections WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'property_id', 'inspection_type', 'status', 'completed_at', 'report_hash', 'report_pdf_bytes', 'report_generated_at']);
    await compareTable(source, target, 'legal.inspection_items',
      'SELECT * FROM legal.inspection_items WHERE company_id = $1 ORDER BY id', byCompany,
      ['inspection_id', 'item_name', 'condition', 'notes']);
    await compareTable(source, target, 'legal.inspection_signatures',
      'SELECT * FROM legal.inspection_signatures WHERE company_id = $1 ORDER BY id', byCompany,
      ['inspection_id', 'party_role', 'signed_by_user_id', 'signature_hash', 'signed_at']);
    const fileLinks = await compareTable(source, target, 'people.file_links',
      'SELECT * FROM people.file_links WHERE company_id = $1 ORDER BY id', byCompany,
      ['file_id', 'related_entity_type', 'related_entity_id', 'purpose']);
    const files = await compareTable(source, target, 'people.files (metadados)',
      'SELECT id, storage_key, file_name, mime_type, size_bytes, checksum_sha256 FROM people.files WHERE company_id = $1 ORDER BY id', byCompany,
      ['storage_key', 'file_name', 'mime_type', 'size_bytes', 'checksum_sha256']);
    await compareTable(source, target, 'legal.legal_cases',
      'SELECT * FROM legal.legal_cases WHERE company_id = $1 ORDER BY id', byCompany,
      ['contract_id', 'case_number', 'case_type', 'status', 'phase', 'legal_hold', 'responsible_user_id']);
    const packages = await compareTable(source, target, 'legal.evidence_packages',
      'SELECT * FROM legal.evidence_packages WHERE company_id = $1 ORDER BY id', byCompany,
      ['legal_case_id', 'manifest_json', 'package_hash', 'created_by']);
    await compareTable(source, target, 'legal.evidence_package_access_log',
      'SELECT * FROM legal.evidence_package_access_log WHERE company_id = $1 ORDER BY id', byCompany,
      ['evidence_package_id', 'accessed_by_user_id', 'action', 'accessed_at']);

    await compareTable(source, target, 'finance.financial_entries',
      'SELECT * FROM finance.financial_entries WHERE company_id = $1 ORDER BY id', byCompany,
      ['entry_type', 'nature', 'amount', 'status', 'due_at', 'settled_at', 'bank_account_id', 'idempotency_key', 'parent_entry_id', 'lock_version']);
    await compareTable(source, target, 'finance.payment_intents',
      'SELECT * FROM finance.payment_intents WHERE company_id = $1 ORDER BY id', byCompany,
      ['financial_entry_id', 'status', 'snapshot_hash', 'external_submission_id', 'external_status', 'idempotency_key', 'executed_at']);
    await compareTable(source, target, 'finance.bank_payment_provider_routing',
      'SELECT * FROM finance.bank_payment_provider_routing WHERE company_id = $1 ORDER BY id', byCompany,
      ['external_submission_id', 'payment_intent_id', 'group_id', 'company_id']);

    // 2. Bytes dos arquivos: blob cifrado copiado bit a bit + conteúdo decifrado = checksum gravado.
    console.log('\n--- Bytes dos arquivos (storage em disco, cifrado em repouso) ---');
    const targetUploads = process.env.UPLOADS_DIR;
    let bytesVerified = 0;
    const filesDetail = [];
    for (const file of files) {
      const srcBlob = fs.readFileSync(path.join(args['source-uploads'], file.storage_key));
      const tgtBlob = fs.readFileSync(path.join(targetUploads, file.storage_key));
      const srcPlain = decryptFileBuffer(srcBlob);
      const tgtPlain = decryptFileBuffer(tgtBlob);
      const blobOk = sha256(srcBlob) === sha256(tgtBlob);
      const plainOk = sha256(tgtPlain) === file.checksum_sha256 && sha256(srcPlain) === file.checksum_sha256;
      const notEmpty = tgtPlain.length > 0 && tgtPlain.length === Number(file.size_bytes);
      check('arquivos (bytes)', `${file.file_name}: blob cifrado idêntico (${tgtBlob.length} bytes)`, blobOk);
      check('arquivos (bytes)', `${file.file_name}: SHA-256 do conteúdo decifrado = checksum gravado (${file.checksum_sha256.slice(0, 16)}…)`, plainOk);
      check('arquivos (bytes)', `${file.file_name}: conteúdo não vazio e do tamanho gravado (${tgtPlain.length} bytes)`, notEmpty);
      if (blobOk && plainOk && notEmpty) bytesVerified += 1;
      filesDetail.push({ fileName: file.file_name, sizeBytes: tgtPlain.length, sha256: file.checksum_sha256 });
    }
    objectSummary.push({ objectName: 'arquivos (bytes)', records: files.length, fields: ['blob cifrado sha256', 'conteúdo decifrado sha256 = checksum_sha256', 'tamanho = size_bytes'], fieldChecks: files.length * 3, fieldFailures: files.length - bytesVerified });

    console.log('\n--- PDF do relatório de vistoria (bytea no banco) ---');
    for (const inspection of inspections) {
      const restored = await target.query('SELECT report_pdf_bytes, report_hash FROM legal.inspections WHERE id = $1', [inspection.id]);
      const pdf = restored.rows[0].report_pdf_bytes;
      check('relatório de vistoria (bytes)', `vistoria ${inspection.id}: PDF restaurado não vazio (${pdf ? pdf.length : 0} bytes) e SHA-256 = report_hash`,
        Boolean(pdf) && pdf.length > 0 && sha256(pdf) === restored.rows[0].report_hash);
    }

    // 3. Relações: cada referência do destino aponta para um registro restaurado do mesmo tenant.
    console.log('\n--- Relações no banco restaurado ---');
    const tgtVersionIds = new Set((await target.query('SELECT id, contract_id FROM legal.contract_versions WHERE company_id = $1', byCompany)).rows.map((r) => r.id));
    const tgtFileIds = new Set((await target.query('SELECT id FROM people.files WHERE company_id = $1', byCompany)).rows.map((r) => r.id));
    for (const signature of signatures) {
      check('relações', `assinatura ${signature.id} → versão ${signature.contract_version_id} existe no destino`, tgtVersionIds.has(signature.contract_version_id));
    }
    for (const version of versions) {
      if (version.document_file_id) check('relações', `versão ${version.id} → documento ${version.document_file_id} existe no destino`, tgtFileIds.has(version.document_file_id));
    }
    for (const link of fileLinks) {
      check('relações', `file_link ${link.id} → arquivo ${link.file_id} existe no destino`, tgtFileIds.has(link.file_id));
    }
    for (const pkg of packages) {
      for (const item of pkg.manifest_json) {
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

    // 4. Exportação e permissões pós-restore, pelos serviços e pela API reais contra o destino.
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
  check('exportação pós-restore', `manifesto exportado (${exported.itemCount} itens) recalculado = hash gravado ANTES do backup (${A.evidencePackageHash.slice(0, 16)}…)`, integrity.valid);
  for (const item of exported.manifest) {
    const fileId = await resolveManifestFileId(targetSuper, A.companyId, item.referenceId);
    const content = fileId ? await inTenant(A, (t) => filesService.getFileContent(fileId, t)) : null;
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
  const crossFile = await expectError(() => inTenant(B, (t) => filesService.getFileContent(someFile, t)), 'FILE_NOT_FOUND');
  check('permissões pós-restore', `tenant B baixando arquivo de A → ${crossFile.got}`, crossFile.ok);

  const counts = await inTenant(B, async (t) => {
    const q = async (sql, replacements) => (await sequelize.query(sql, { replacements, transaction: t, type: sequelize.QueryTypes.SELECT }))[0].n;
    return {
      contractsA: await q('SELECT COUNT(*)::int AS n FROM legal.contracts WHERE id = :id', { id: A.contractId }),
      versionsA: await q('SELECT COUNT(*)::int AS n FROM legal.contract_versions WHERE id = :id', { id: A.contractVersionId }),
      signaturesA: await q('SELECT COUNT(*)::int AS n FROM legal.signatures WHERE id IN (:ids)', { ids: A.signatureIds }),
      filesA: await q('SELECT COUNT(*)::int AS n FROM people.files WHERE id IN (:ids)', { ids: A.files }),
      packagesA: await q('SELECT COUNT(*)::int AS n FROM legal.evidence_packages WHERE id = :id', { id: A.evidencePackageId }),
      ownContract: await q('SELECT COUNT(*)::int AS n FROM legal.contracts WHERE id = :id', { id: B.contractId }),
    };
  });
  check('permissões pós-restore', `tenant B não enxerga contrato/versão/assinaturas/arquivos/dossiê de A (${counts.contractsA}/${counts.versionsA}/${counts.signaturesA}/${counts.filesA}/${counts.packagesA})`,
    counts.contractsA + counts.versionsA + counts.signaturesA + counts.filesA + counts.packagesA === 0);
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
  const tokenFor = (tenant, permissions) => signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['drill'], permissions });

  const logBefore = Number((await targetSuper.query('SELECT COUNT(*)::int AS n FROM legal.evidence_package_access_log WHERE evidence_package_id = $1 AND action = $2', [A.evidencePackageId, 'EXPORTED'])).rows[0].n);

  const noPerm = await fetch(`${baseUrl}${exportPath}`, { headers: { Authorization: `Bearer ${tokenFor(A, ['contracts:read'])}` } });
  check('permissões pós-restore', `perfil do tenant A SEM legal:read exportando o dossiê → HTTP ${noPerm.status}`, noPerm.status === 403);
  const otherTenant = await fetch(`${baseUrl}${exportPath}`, { headers: { Authorization: `Bearer ${tokenFor(B, ['legal:read'])}` } });
  check('permissões pós-restore', `tenant B COM legal:read exportando o dossiê de A → HTTP ${otherTenant.status}`, otherTenant.status === 404);
  const fileOther = await fetch(`${baseUrl}/files/${A.files[0]}/content`, { headers: { Authorization: `Bearer ${tokenFor(B, ['legal:read'])}` } });
  check('permissões pós-restore', `tenant B baixando arquivo de A pela API → HTTP ${fileOther.status}`, fileOther.status === 404);
  const allowed = await fetch(`${baseUrl}${exportPath}`, { headers: { Authorization: `Bearer ${tokenFor(A, ['legal:read'])}` } });
  const allowedBody = allowed.status === 200 ? await allowed.json() : null;
  const allowedIntegrity = allowedBody ? evidencePackagesService.verifyEvidencePackageIntegrity(allowedBody.data, A.evidencePackageHash) : { valid: false };
  check('permissões pós-restore', `controle positivo: tenant A COM legal:read → HTTP ${allowed.status}, export íntegro contra o hash pré-backup`, allowed.status === 200 && allowedIntegrity.valid);

  const logAfter = Number((await targetSuper.query('SELECT COUNT(*)::int AS n FROM legal.evidence_package_access_log WHERE evidence_package_id = $1 AND action = $2', [A.evidencePackageId, 'EXPORTED'])).rows[0].n);
  check('permissões pós-restore', `cadeia de custódia: só o export permitido gerou registro EXPORTED (${logBefore} → ${logAfter})`, logAfter === logBefore + 1);

  // 5. Replay pós-restore do callback bancário já processado antes do backup (F06).
  console.log('\n--- Replay pós-restore do callback bancário (F06) ---');
  const { confirmBankPayment } = require('../../src/features/finance/bankPayments.service');
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
  // Mesmo caminho do webhook: a rota pública resolve o tenant pela tabela de roteamento e
  // chama confirmBankPayment dentro de uma transação. Duas entregas seguidas.
  for (let i = 1; i <= 2; i += 1) {
    const replayed = await inTenant(A, (t) => confirmBankPayment(bp.externalSubmissionId, 'CONFIRMED', t));
    check('replay pós-restore', `entrega ${i} do mesmo callback CONFIRMED contra o banco restaurado → intenção segue ${replayed.status}, sem reprocessar`, replayed.status === 'EXECUTED');
  }
  const afterReplay = await countRows();
  check('replay pós-restore', `nenhum lançamento novo (${beforeReplay.entries} → ${afterReplay.entries}), nenhum filho (${afterReplay.children}), lançamento intocado (lock_version ${beforeReplay.lock_version} → ${afterReplay.lock_version})`,
    afterReplay.entries === beforeReplay.entries && afterReplay.children === 0 && afterReplay.lock_version === beforeReplay.lock_version && afterReplay.settled === 1);

  // 6. Adulteração deliberada de bytes no storage restaurado: tem que ser detectada.
  console.log('\n--- Adulteração deliberada de um arquivo restaurado ---');
  const victim = (await targetSuper.query('SELECT storage_key, checksum_sha256 FROM people.files WHERE id = $1', [A.files[0]])).rows[0];
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
  fs.writeFileSync(victimPath, original);
  check('adulteração', 'um byte alterado no blob restaurado é detectado (autenticação AES-GCM / checksum)', detected);

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
    const failed = results.filter((r) => !r.ok);
    console.log('\n=== Resumo por objeto ===');
    for (const s of objectSummary) {
      console.log(`  ${s.fieldFailures === 0 ? '✅' : '❌'} ${s.objectName}: ${s.records} registro(s), ${s.fieldChecks} comparações — campos: ${s.fields.join(', ')}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} checagens aprovadas.`);
    console.log(failed.length === 0 ? '✅ RESULTADO FINAL: restore jurídico íntegro (dados, bytes, relações, exportação e permissões).' : '❌ RESULTADO FINAL: falhas encontradas — ver acima.');
    fs.writeFileSync(args.report, JSON.stringify({ objectSummary, results }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
