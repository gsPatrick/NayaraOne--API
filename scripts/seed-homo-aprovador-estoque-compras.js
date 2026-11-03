'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { sequelize, User, Role, Permission, RolePermission, UserMembership, MfaCredential } = require('../src/models');
const { encryptSecret } = require('../src/utils/mfaCrypto');

/**
 * Conta de teste para a conferência da Nayara (pedido de 28/10/2026): um SEGUNDO usuário aprovador,
 * distinto do autor, para decidir (aprovar e rejeitar) excedentes de recebimento (Compras), perdas e
 * ajustes de estoque. O aprovador de Compras já existente (seed-homo-aprovador-compras.js) não tem
 * `inventory:approve` de propósito (prova que Compras não decide estoque); esta conta é separada.
 *
 * Conjunto mínimo: leitura de Estoque e Compras, `procurement:approve` (excedentes), `inventory:approve`
 * (perdas e ajustes) e as leituras que as telas pedem para abrir (obra, pessoa, usuário). Não tem
 * permissão de criar movimento de estoque nem de administrar usuários. A regra "quem propõe não decide"
 * continua valendo no serviço e no banco.
 *
 * MFA TOTP já configurado. Senha e segredo são gerados a cada execução e gravados num arquivo com
 * permissão 0600, FORA do repositório; nunca no console. Entrega pelo meio seguro. Recusa produção.
 *
 * Uso: node scripts/seed-homo-aprovador-estoque-compras.js --out <arquivo>   (idempotente)
 */
const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';
const EMAIL = 'aprovador.estoque@nayaraone.dev';
const NAME = 'HOMO QA — Aprovador Estoque e Compras';
const ROLE_NAME = 'HOMO QA — Aprovador Estoque e Compras';
const PERMISSION_CODES = [
  'procurement:read',
  'procurement:approve', // decidir divergência (excedente) de recebimento
  'inventory:read',
  'inventory:approve', // decidir perda e ajuste de estoque
  'construction:read',
  'people:read',
  'users:read',
];

async function tenant(t) {
  await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
    replacements: { g: GROUP_ID, c: COMPANY_ID, u: ADMIN_USER_ID },
    transaction: t,
  });
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (!out || out.startsWith('--')) throw new Error('Informe --out <arquivo> para gravar as credenciais fora do repositório.');
  const t = await sequelize.transaction();
  try {
    await tenant(t);
    const permissions = await Permission.findAll({ where: { code: PERMISSION_CODES }, transaction: t });
    const faltando = PERMISSION_CODES.filter((c) => !permissions.some((p) => p.code === c));
    if (faltando.length) throw new Error(`Permissões não encontradas no banco: ${faltando.join(', ')}.`);

    const [role] = await Role.findOrCreate({
      where: { groupId: GROUP_ID, companyId: COMPANY_ID, name: ROLE_NAME },
      defaults: { groupId: GROUP_ID, companyId: COMPANY_ID, description: 'Papel de teste: decide excedentes, perdas e ajustes; não cria movimento de estoque.', isSystem: false, createdBy: ADMIN_USER_ID },
      transaction: t,
    });
    const querIds = new Set(permissions.map((p) => p.id));
    for (const link of await RolePermission.findAll({ where: { roleId: role.id }, transaction: t })) {
      if (!querIds.has(link.permissionId)) await link.destroy({ transaction: t });
    }
    for (const p of permissions) {
      await RolePermission.findOrCreate({
        where: { roleId: role.id, permissionId: p.id },
        defaults: { groupId: GROUP_ID, companyId: COMPANY_ID, roleId: role.id, permissionId: p.id, createdBy: ADMIN_USER_ID },
        transaction: t,
      });
    }

    const senha = `Apr#${crypto.randomBytes(12).toString('base64url')}7`;
    const passwordHash = await bcrypt.hash(senha, 12);
    const [user, created] = await User.findOrCreate({
      where: { email: EMAIL },
      defaults: { name: NAME, passwordHash, status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP', createdBy: ADMIN_USER_ID },
      transaction: t,
    });
    if (!created) await user.update({ passwordHash, status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP', updatedBy: ADMIN_USER_ID }, { transaction: t });

    await UserMembership.findOrCreate({
      where: { groupId: GROUP_ID, companyId: COMPANY_ID, userId: user.id, roleId: role.id },
      defaults: { groupId: GROUP_ID, companyId: COMPANY_ID, userId: user.id, roleId: role.id, status: 'ACTIVE', createdBy: ADMIN_USER_ID },
      transaction: t,
    });

    const segredo = authenticator.generateSecret();
    const cred = await MfaCredential.findOne({ where: { userId: user.id }, transaction: t });
    if (cred) await cred.update({ secretEncrypted: encryptSecret(segredo), enabled: true, confirmedAt: new Date() }, { transaction: t });
    else await MfaCredential.create({ userId: user.id, groupId: GROUP_ID, companyId: COMPANY_ID, secretEncrypted: encryptSecret(segredo), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }, { transaction: t });

    await t.commit();
    fs.writeFileSync(
      out,
      `Conta de teste: segundo aprovador (Estoque e Compras). Entregar pelo meio seguro; não colar em chat aberto.\n\n${EMAIL}\n  senha: ${senha}\n  chave TOTP (autenticador): ${segredo}\n  empresa: Nayara One — Empresa Dev\n  permissões: ${PERMISSION_CODES.join(', ')}\n`,
      { mode: 0o600 }
    );
    console.log(`Conta ${created ? 'criada' : 'atualizada'}: ${EMAIL}. Credenciais gravadas em ${out} (0600).`);
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  } finally {
    await sequelize.close();
  }
}

main().catch((e) => { console.error('Falha:', e.message); process.exit(1); });
