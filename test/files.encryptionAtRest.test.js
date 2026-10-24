'use strict';

// ACHADO REAL FECHADO (auditoria pós-DoD, Marco 8, 14/10/2026): documento em repouso (disco)
// nunca era criptografado — gap pré-existente de todo o projeto (storage genérico usado por
// Jurídico/Obras/Estoque/Correspondente). Fechado com src/utils/fileCrypto.js (AES-256-GCM,
// mesmo padrão de mfaCrypto.js), integrado em files.service.js#uploadFile/getFileContent.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const filesService = require('../src/features/files/files.service');
const diskStorage = require('../src/utils/diskStorage');
const { encryptFileBuffer, decryptFileBuffer } = require('../src/utils/fileCrypto');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

test('fileCrypto: encrypt/decrypt roundtrip devolve o conteúdo original byte a byte', () => {
  const original = Buffer.from('conteúdo de teste binário \x00\x01\xff', 'binary');
  const encrypted = encryptFileBuffer(original);
  assert.ok(!encrypted.equals(original), 'o blob gravado em disco nunca deve ser igual ao plaintext');
  const decrypted = decryptFileBuffer(encrypted);
  assert.ok(decrypted.equals(original));
});

test('fileCrypto: decryptFileBuffer devolve arquivo LEGADO (sem marker) sem alteração, nunca lança erro', () => {
  const legacyPlainBuffer = Buffer.from('arquivo gravado antes da criptografia existir');
  const result = decryptFileBuffer(legacyPlainBuffer);
  assert.ok(result.equals(legacyPlainBuffer));
});

test('fileCrypto: blob criptografado diferente a cada chamada (IV aleatório), mesmo conteúdo', () => {
  const original = Buffer.from('mesmo conteúdo duas vezes');
  const a = encryptFileBuffer(original);
  const b = encryptFileBuffer(original);
  assert.ok(!a.equals(b), 'IV aleatório deve produzir ciphertext diferente a cada chamada');
  assert.ok(decryptFileBuffer(a).equals(original));
  assert.ok(decryptFileBuffer(b).equals(original));
});

test('files: upload novo grava criptografado em disco (nunca plaintext legível) e getFileContent devolve o original', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const plainText = 'ESTE TEXTO NUNCA PODE APARECER EM CLARO NO DISCO';
    const file = await filesService.uploadFile(
      withTenant({
        fileName: 'comprovante-renda.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from(plainText).toString('base64'),
        category: 'generic',
      }),
      tenant.userId,
      transaction
    );

    // Lê o blob DIRETO do disco (sem passar por getFileContent/decrypt) — confirma que o texto
    // original não está legível em claro no arquivo gravado.
    const rawDiskBuffer = diskStorage.readFile(file.storageKey);
    assert.ok(!rawDiskBuffer.includes(plainText), 'conteúdo em claro nunca deve aparecer no arquivo gravado em disco');

    const content = await filesService.getFileContent(file.id, transaction);
    assert.equal(content.content.toString('utf8'), plainText);
  });
});

test('files: arquivo legado em disco (gravado sem criptografia) continua legível via getFileContent', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Simula um arquivo gravado ANTES desta mudança: grava o plaintext puro no disco (sem passar
    // por uploadFile/encryptFileBuffer) e cria o registro File manualmente, igual o storage fazia
    // antes.
    const plainText = 'arquivo legado, gravado sem criptografia';
    const storageKey = diskStorage.saveFile('generic', tenant.groupId, 'legado.txt', Buffer.from(plainText));

    const { File } = require('../src/models');
    const legacyFile = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        storageKey,
        fileName: 'legado.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(plainText),
        checksumSha256: require('crypto').createHash('sha256').update(plainText).digest('hex'),
        // Registro legado: a migration 20260101000395 marcou todos os arquivos anteriores com
        // encrypted_at_rest = false; arquivo novo nasce true e é recusado sem o marcador de cifra.
        encryptedAtRest: false,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    const content = await filesService.getFileContent(legacyFile.id, transaction);
    assert.equal(content.content.toString('utf8'), plainText);
  });
});

test('fileCrypto: FILES_ENCRYPTION_KEY ausente falha fechado (erro claro, não silencioso)', () => {
  const original = process.env.FILES_ENCRYPTION_KEY;
  delete process.env.FILES_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptFileBuffer(Buffer.from('x')), (err) => {
      assert.equal(err.code, 'FILES_CRYPTO_CONFIG_MISSING');
      return true;
    });
  } finally {
    process.env.FILES_ENCRYPTION_KEY = original;
  }
});
