'use strict';

// Recusa de anexo adiada (pentest M5, achado 10) sem afrouxar a regra do Marco 9: o fileAttachGuard guarda FILE_ATTACH_FORBIDDEN para quem
// não tem a permissão da rota receber PERMISSION_DENIED; com a permissão, a recusa guardada vale. Integração dos Marcos 3 a 6 (14/11/2026):
// a recusa só era devolvida por requirePermission e pela transação da empresa; uma rota protegida por outro middleware de permissão
// (anyOf da NAY, requireAnyPermission da governança, BI, Marketing) seguia com o anexo. Agora todo middleware de permissão passa por
// nextWithDeferredFileAttach. Sem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const RECUSA = Object.assign(new Error('anexo'), { code: 'FILE_ATTACH_FORBIDDEN' });

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('todo middleware de permissão (marca requiredPermission) devolve a recusa de anexo adiada ou delega a requirePermission', () => {
  const semRecusa = [];
  for (const f of arquivos(SRC)) {
    const texto = fs.readFileSync(f, 'utf8');
    if (!/\.requiredPermission\s*=/.test(texto)) continue;
    if (texto.includes('nextWithDeferredFileAttach(') || /const check = requirePermission\(/.test(texto)) continue;
    semRecusa.push(path.relative(SRC, f));
  }
  assert.deepEqual(semRecusa, []);
});

const comPermissao = { auth: { permissions: ['x:y', 'analytics:read'], groupId: 'g', companyId: 'c' } };
const casos = [
  ['requirePermission', () => require('../src/middlewares/auth.middleware').requirePermission('x:y')],
  ['anyOf (NAY)', () => require('../src/features/ai/anyOf').anyOf('z:z', 'x:y')],
  ['requireAnyPermission (governança)', () => require('../src/features/core-governance/governance.anyPermission').requireAnyPermission(['x:y'])],
  ['requireAnalyticsPermission (BI)', () => require('../src/features/analytics/security/permissionGuard').requireAnalyticsPermission('analytics:read')],
];

for (const [nome, fabrica] of casos) {
  test(`${nome}: com a permissão, a recusa de anexo guardada vale; sem recusa guardada, segue`, () => {
    const mw = fabrica();
    let recebido = 'nada';
    mw({ ...comPermissao, deferredFileAttachError: RECUSA }, {}, (err) => { recebido = err; });
    assert.equal(recebido, RECUSA);
    mw({ ...comPermissao }, {}, (err) => { recebido = err; });
    assert.equal(recebido, undefined);
  });
}

test('sem a permissão, a resposta é PERMISSION_DENIED mesmo com a recusa de anexo guardada (o achado do pentest)', () => {
  const mw = require('../src/features/ai/anyOf').anyOf('z:z');
  let recebido = null;
  mw({ ...comPermissao, deferredFileAttachError: RECUSA }, {}, (err) => { recebido = err; });
  assert.equal(recebido.code, 'PERMISSION_DENIED');
});
