'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { sequelize, User, Role, Permission, RolePermission, UserMembership, MfaCredential, Company } = require('../src/models');
const { encryptSecret } = require('../src/utils/mfaCrypto');

/**
 * Contas de teste para a auditoria da Nayara (pedido da IA auditora, 24/10/2026):
 *   1. "auditoria.leitura": só leitura em todos os módulos (nenhuma permissão de criar, editar, aprovar,
 *      liquidar ou excluir), vinculada SOMENTE à Empresa Dev;
 *   2. "auditoria.empresab": só leitura, vinculada SOMENTE à empresa "HOMO QA — M45 Intercompany Destino".
 * Servem para provar, pela tela e pela API, as recusas de autorização e o isolamento entre empresas.
 * MFA TOTP já configurado (o segredo é do operador). Senha e segredo são gerados a cada execução e gravados
 * num arquivo com permissão 0600, FORA do repositório — nunca no console. Entrega pelo meio seguro.
 *
 * Uso: node scripts/seed-homo-auditoria-nayara.js --out <arquivo>   (recusa produção; idempotente)
 */
const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const DEV_COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';
const DEST_COMPANY_NAME = 'HOMO QA — M45 Intercompany Destino';
const ROLE_NAME = 'HOMO QA — Auditoria somente leitura';
const CONTAS = [
  { chave: 'leitura', email: 'auditoria.leitura@nayaraone.dev', name: 'HOMO QA — Auditoria (somente leitura, Empresa Dev)', empresa: 'dev' },
  { chave: 'empresab', email: 'auditoria.empresab@nayaraone.dev', name: 'HOMO QA — Auditoria (somente leitura, empresa B)', empresa: 'destino' },
];

async function tenant(t, companyId) {
  await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
    replacements: { g: GROUP_ID, c: companyId, u: ADMIN_USER_ID },
    transaction: t,
  });
}

async function garantirPapel(t, companyId, permissions) {
  await tenant(t, companyId);
  const [role] = await Role.findOrCreate({
    where: { groupId: GROUP_ID, companyId, name: ROLE_NAME },
    defaults: { groupId: GROUP_ID, companyId, description: 'Papel de teste: consulta tudo e não altera nada.', isSystem: false, createdBy: ADMIN_USER_ID },
    transaction: t,
  });
  const querIds = new Set(permissions.map((p) => p.id));
  for (const link of await RolePermission.findAll({ where: { roleId: role.id }, transaction: t })) {
    if (!querIds.has(link.permissionId)) await link.destroy({ transaction: t });
  }
  for (const p of permissions) {
    await RolePermission.findOrCreate({
      where: { roleId: role.id, permissionId: p.id },
      defaults: { groupId: GROUP_ID, companyId, roleId: role.id, permissionId: p.id, createdBy: ADMIN_USER_ID },
      transaction: t,
    });
  }
  return role;
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (!out || out.startsWith('--')) throw new Error('Informe --out <arquivo> para gravar as credenciais fora do repositório.');
  const t = await sequelize.transaction();
  const linhas = [];
  try {
    const todas = await Permission.findAll({ transaction: t });
    const leitura = todas.filter((p) => /:read$/.test(p.code) && !['correspondent:documents:read', 'crm:opportunities:read:all'].includes(p.code));
    const proibidas = leitura.filter((p) => /:(create|update|delete|approve|export|manage)$/.test(p.code));
    if (proibidas.length) throw new Error('Papel somente leitura não pode ter permissão de alteração.');

    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: GROUP_ID }, transaction: t });
    const destino = await Company.findOne({ where: { groupId: GROUP_ID, name: DEST_COMPANY_NAME }, transaction: t });
    if (!destino) throw new Error('Empresa de teste destino não encontrada.');
    const empresas = { dev: DEV_COMPANY_ID, destino: destino.id };
    const papeis = { dev: await garantirPapel(t, DEV_COMPANY_ID, leitura), destino: await garantirPapel(t, destino.id, leitura) };

    for (const conta of CONTAS) {
      await tenant(t, DEV_COMPANY_ID);
      const senha = `Aud#${crypto.randomBytes(12).toString('base64url')}7`;
      const passwordHash = await bcrypt.hash(senha, 12);
      const [user, created] = await User.findOrCreate({
        where: { email: conta.email },
        defaults: { name: conta.name, passwordHash, status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP', createdBy: ADMIN_USER_ID },
        transaction: t,
      });
      if (!created) await user.update({ passwordHash, status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP', updatedBy: ADMIN_USER_ID }, { transaction: t });

      const companyId = empresas[conta.empresa];
      await tenant(t, companyId);
      // Remove vínculos antigos fora da empresa certa e garante exatamente um vínculo ativo, com o papel de leitura.
      for (const m of await UserMembership.findAll({ where: { userId: user.id }, transaction: t })) {
        if (m.companyId !== companyId) {
          await tenant(t, m.companyId);
          await m.update({ status: 'INACTIVE' }, { transaction: t });
          await tenant(t, companyId);
        }
      }
      await UserMembership.findOrCreate({
        where: { groupId: GROUP_ID, companyId, userId: user.id, roleId: papeis[conta.empresa].id },
        defaults: { groupId: GROUP_ID, companyId, userId: user.id, roleId: papeis[conta.empresa].id, status: 'ACTIVE', createdBy: ADMIN_USER_ID },
        transaction: t,
      });

      await tenant(t, DEV_COMPANY_ID);
      const segredo = authenticator.generateSecret();
      const cred = await MfaCredential.findOne({ where: { userId: user.id }, transaction: t });
      if (cred) await cred.update({ secretEncrypted: encryptSecret(segredo), enabled: true, confirmedAt: new Date() }, { transaction: t });
      else await MfaCredential.create({ userId: user.id, groupId: GROUP_ID, companyId: DEV_COMPANY_ID, secretEncrypted: encryptSecret(segredo), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }, { transaction: t });
      linhas.push(`${conta.email}\n  senha: ${senha}\n  chave TOTP (autenticador): ${segredo}\n  empresa: ${conta.empresa === 'dev' ? 'Nayara One — Empresa Dev' : DEST_COMPANY_NAME}\n  permissões: ${leitura.length} (somente leitura)\n`);
    }
    await t.commit();
    fs.writeFileSync(out, `Contas de teste para a auditoria da Nayara. Entregar pelo meio seguro; não colar em chat aberto.\n\n${linhas.join('\n')}`, { mode: 0o600 });
    console.log(`Contas criadas ou atualizadas: ${CONTAS.map((c) => c.email).join(', ')}. Credenciais gravadas em ${out} (0600).`);
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  } finally {
    await sequelize.close();
  }
}

main().catch((e) => { console.error('Falha:', e.message); process.exit(1); });
