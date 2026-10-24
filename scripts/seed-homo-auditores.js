'use strict';

require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { sequelize, User, Role, UserMembership, MfaCredential } = require('../src/models');
const { encryptSecret } = require('../src/utils/mfaCrypto');

/**
 * SEED DE HOMOLOGAÇÃO DE TESTES — pedido e autorizado explicitamente pelo Patrick (dono do
 * projeto) em 19/10/2026. O banco alvo é o banco de HOMOLOGAÇÃO DE TESTES, com dados fictícios,
 * que será EXCLUÍDO depois da homologação. Nunca roda em produção (recusa DEPLOY_ENVIRONMENT
 * =production).
 *
 * Cria dois usuários auditores (papel de sistema ADMIN) com MFA TOTP já configurado, para a
 * auditoria ao vivo executar os fluxos com MFA gerando os códigos localmente. São dois porque
 * várias regras são maker-checker (quem faz não aprova). O MFA continua exigido de verdade em
 * login e ações sensíveis — nenhuma regra de segurança do sistema é alterada; só o segredo
 * desses dois usuários de teste é conhecido pelo operador da auditoria.
 *
 * Idempotente. Senha e segredo são gerados a cada execução e impressos uma vez no console.
 */

const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';

const AUDITORS = [
  { email: 'auditor.a@nayaraone.dev', name: 'HOMO QA — Auditor A' },
  { email: 'auditor.b@nayaraone.dev', name: 'HOMO QA — Auditor B' },
];

function strongPassword() {
  return `Aud#${crypto.randomBytes(9).toString('base64url')}9`;
}

async function setTenant(transaction, groupId, companyId) {
  await sequelize.query(
    "SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
    { replacements: { g: groupId, c: companyId, u: ADMIN_USER_ID }, transaction }
  );
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') {
    console.error('Seed de auditores é só para o banco de homologação de testes.');
    process.exit(1);
  }
  const transaction = await sequelize.transaction();
  const output = [];
  try {
    await setTenant(transaction, GROUP_ID, COMPANY_ID);
    const adminRole = await Role.findOne({ where: { name: 'ADMIN', isSystem: true }, transaction });
    if (!adminRole) throw new Error('Papel de sistema ADMIN não encontrado.');
    const adminMemberships = await UserMembership.findAll({ where: { userId: ADMIN_USER_ID, status: 'ACTIVE' }, transaction });
    const companies = [...new Map(adminMemberships.map((m) => [m.companyId, m])).values()];

    for (const auditor of AUDITORS) {
      await setTenant(transaction, GROUP_ID, COMPANY_ID);
      const password = strongPassword();
      const passwordHash = await bcrypt.hash(password, 12);
      const [user, created] = await User.findOrCreate({
        where: { email: auditor.email },
        defaults: { name: auditor.name, passwordHash, status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP', createdBy: ADMIN_USER_ID },
        transaction,
      });
      if (!created) {
        await user.update({ passwordHash, status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP', updatedBy: ADMIN_USER_ID }, { transaction });
      }

      for (const m of companies) {
        await setTenant(transaction, m.groupId, m.companyId);
        await UserMembership.findOrCreate({
          where: { groupId: m.groupId, companyId: m.companyId, userId: user.id, roleId: adminRole.id },
          defaults: { groupId: m.groupId, companyId: m.companyId, userId: user.id, roleId: adminRole.id, status: 'ACTIVE', createdBy: ADMIN_USER_ID },
          transaction,
        });
      }

      await setTenant(transaction, GROUP_ID, COMPANY_ID);
      const secret = authenticator.generateSecret();
      const existing = await MfaCredential.findOne({ where: { userId: user.id }, transaction });
      if (existing) {
        await existing.update({ secretEncrypted: encryptSecret(secret), enabled: true, confirmedAt: new Date() }, { transaction });
      } else {
        await MfaCredential.create(
          { userId: user.id, groupId: GROUP_ID, companyId: COMPANY_ID, secretEncrypted: encryptSecret(secret), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [], createdBy: ADMIN_USER_ID },
          { transaction }
        );
      }
      output.push({ email: auditor.email, password, secret, companies: companies.length });
    }

    await transaction.commit();
    for (const o of output) console.log(`${o.email} | senha: ${o.password} | chave TOTP: ${o.secret} | ADMIN em ${o.companies} empresa(s)`);
    process.exit(0);
  } catch (err) {
    await transaction.rollback().catch(() => {});
    console.error('Falha no seed de auditores:', err.message);
    process.exit(1);
  }
}

main();
