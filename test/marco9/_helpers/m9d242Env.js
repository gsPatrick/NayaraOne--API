'use strict';

// Apoio dos testes de armazenamento de objetos e identidade (M9-D242): ambiente de arquivos/JWT sem depender do .env e contextos de adapter. Quem usa requer este arquivo ANTES de qualquer módulo do sistema.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.FILES_ENCRYPTION_KEY = process.env.FILES_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || crypto.randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex');
process.env.UPLOADS_DIR = process.env.UPLOADS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'm9d242-'));

const novaEmpresa = () => crypto.randomUUID();
const chaveDe = (companyId, relativo = `generic/g1/${crypto.randomUUID()}-arquivo.pdf`) => `company/${companyId}/${relativo}`;

/** Contexto mínimo de um adapter de laboratório (connection fictícia, sem rede). */
const ctxSandbox = (id = `t-${crypto.randomUUID()}`, config = {}) => Object.freeze({
  connection: Object.freeze({ id, providerCode: 'teste', environment: 'SANDBOX', apiVersion: null, config }), policy: {}, timeouts: { readMs: 200, writeMs: 200 }, http: null, secret: null,
});

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** O tenant fictício A do CI (empresa e o usuário "maker", sem papel de administrador), onde o login real acontece. Exige o seed de dois tenants. */
async function tenantCiA() {
  const { Group, Company, User, sequelize } = require('../../../src/models');
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const group = await Group.findOne({ where: { name: 'CI — Grupo Fictício A' } });
  const company = await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: group.id }, transaction: t });
    return Company.findOne({ where: { groupId: group.id, name: 'CI — Empresa Fictícia A' }, transaction: t });
  });
  const user = await User.findOne({ where: { email: emailFor('A', 'maker') } });
  return { groupId: group.id, companyId: company.id, userId: user.id, email: user.email, password: process.env.CI_TENANT_USERS_PASSWORD };
}

/** Token sem assinatura (alg none) com as claims dadas, para provar que o adapter o recusa. */
const tokenSemAssinatura = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
};

module.exports = { tokenSemAssinatura, novaEmpresa, chaveDe, ctxSandbox, sha256, crypto, tenantCiA };
