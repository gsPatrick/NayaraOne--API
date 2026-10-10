'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const filesService = require('../src/features/files/files.service');
const AppError = require('../src/utils/AppError');

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

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06): uploadFile aceitava
// qualquer mimeType sem allowlist — um arquivo marcado "text/html" contendo <script> era aceito
// e servido de volta com Content-Type: text/html + Content-Disposition: inline, executando o
// script no navegador de quem abrisse o link (stored XSS). Executáveis também não eram bloqueados.
test('files: uploadFile recusa mimeType fora da allowlist (html/script, executável)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contentBase64 = Buffer.from('<script>alert(document.domain)</script>').toString('base64');
    await assert.rejects(
      () => filesService.uploadFile(
        withTenant({ fileName: 'evil.html', mimeType: 'text/html', contentBase64, category: 'generic' }),
        tenant.userId,
        transaction
      ),
      (err) => { assert.ok(err instanceof AppError); assert.equal(err.code, 'FILE_UPLOAD_TYPE_NOT_ALLOWED'); return true; }
    );

    await assert.rejects(
      () => filesService.uploadFile(
        withTenant({ fileName: 'malware.exe', mimeType: 'application/x-msdownload', contentBase64: Buffer.from('MZ').toString('base64'), category: 'generic' }),
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'FILE_UPLOAD_TYPE_NOT_ALLOWED'); return true; }
    );

    await assert.rejects(
      () => filesService.uploadFile(
        withTenant({ fileName: 'sem-tipo', contentBase64, category: 'generic' }),
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'FILE_UPLOAD_TYPE_NOT_ALLOWED'); return true; }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 15, 2026-10-06): upload de arquivo
// vazio (contentBase64="") era tratado igual a campo AUSENTE, vazando nomes de parâmetro interno
// ("groupId", "companyId") na mensagem de erro em vez de "arquivo vazio" (mensagem de negócio
// que nunca era alcançada nesse caso).
test('files: uploadFile recusa arquivo vazio com mensagem de negócio, não vaza nome de parâmetro interno', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => filesService.uploadFile(
        withTenant({ fileName: 'vazio.jpg', mimeType: 'image/jpeg', contentBase64: '', category: 'generic' }),
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FILE_UPLOAD_VALIDATION');
        assert.match(err.message, /vazio/i);
        assert.doesNotMatch(err.message, /groupId/);
        return true;
      }
    );
  });
});

test('files: uploadFile aceita mimeType permitido (imagem, PDF)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const file = await filesService.uploadFile(
      withTenant({ fileName: 'foto.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('FAKE_JPEG').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    assert.equal(file.mimeType, 'image/jpeg');

    const pdf = await filesService.uploadFile(
      withTenant({ fileName: 'laudo.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('FAKE_PDF').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    assert.equal(pdf.mimeType, 'application/pdf');
  });
});
