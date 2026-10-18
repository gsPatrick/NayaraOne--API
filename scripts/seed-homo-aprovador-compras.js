'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { sequelize, User, Role, Permission, RolePermission, UserMembership, MfaCredential } = require('../src/models');
const { encryptSecret } = require('../src/utils/mfaCrypto');

/**
 * Seed de homologação — cria o usuário "HOMO QA — Aprovador Compras" com MFA TOTP já
 * configurado DIRETO NO BANCO (segredo real gerado pelo otplib, cifrado pelo mesmo
 * mfaCrypto.js do runtime), para permitir testar o fluxo de Compras pós-"Solicitada"
 * (cotação → pedido → recebimento) com um segundo usuário aprovador, respeitando a
 * segregação maker-checker (o admin de seed não pode aprovar a própria requisição).
 *
 * Por que direto no banco e não pela tela/endpoint: o fluxo real de habilitar MFA exige
 * um humano escaneando QR code; para um usuário de TESTE de homologação, o segredo é
 * impresso no console ao final — quem for operar o teste cadastra esse segredo num app
 * autenticador (ou gera códigos via otplib) e consegue logar normalmente. Nenhuma regra
 * de MFA do runtime é enfraquecida: o login desse usuário vai exigir TOTP de verdade.
 *
 * Idempotente: rodar de novo não duplica nada (findOrCreate em tudo); o segredo TOTP só é
 * criado na primeira execução (execuções seguintes preservam o existente e avisam).
 *
 * Uso: APPROVER_SEED_PASSWORD='<senha-do-teste>' node scripts/seed-homo-aprovador-compras.js
 * (a senha nunca fica gravada neste arquivo — vem do ambiente na hora de rodar).
 */

const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';

const APPROVER_EMAIL = 'aprovador.compras@nayaraone.dev';
const APPROVER_NAME = 'HOMO QA — Aprovador Compras';
const ROLE_NAME = 'HOMO QA — Aprovador Compras';
// construction:read e units:read adicionados em 17/10: a tela de Requisições de compra
// resolve a obra vinculada (construction) e o Painel carrega as unidades (units) logo após
// o login — sem elas o aprovador via "Permissão ausente" e nenhuma requisição listada.
// 18/10 (auditoria Compras E2E): procurement:create adicionado — sem ele o aprovador não
// consegue cotar/criar pedido/receber (rotas de cotação, oferta e goods-receipt exigem
// create), nem criar a própria requisição pra provar o negativo do maker-checker (a
// segregação é garantida pela REGRA "quem cria não aprova", não pela ausência da permissão).
// users:read + leituras do Painel (people/properties/radar/crm:opportunities) adicionadas
// pra tela inicial carregar sem "Permissão ausente".
const PERMISSION_CODES = [
  'procurement:read',
  'procurement:approve',
  'procurement:create',
  'inventory:read',
  'construction:read',
  'units:read',
  'users:read',
  'people:read',
  'properties:read',
  'radar:read',
  'crm:opportunities:read',
  // FIX (auditoria "reconf" 18/10/2026, 3ª permissão faltante em 3 rodadas): o conjunto agora
  // foi levantado MAPEANDO todas as chamadas de app/painel/page.js (listProperties, listPeople,
  // listDuplicatePairs, listOpportunities, listRadars, /companies, /units, /users,
  // /memberships) contra o requirePermission de cada rota — e é TRAVADO pelo teste
  // test/painelApproverPermissions.test.js, que chama cada endpoint do Painel com um usuário
  // de exatamente estas permissões e exige 200 em todos. Permissão nova no Painel => o teste
  // quebra antes de qualquer rodada de auditoria.
  'companies:read',
  'memberships:read',
];

async function main() {
  const approverPassword = process.env.APPROVER_SEED_PASSWORD;
  if (!approverPassword || approverPassword.length < 10) {
    console.error('Defina APPROVER_SEED_PASSWORD (mínimo 10 caracteres) ao rodar este seed.');
    process.exit(1);
  }

  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: GROUP_ID }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: COMPANY_ID }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: ADMIN_USER_ID }, transaction });

    const passwordHash = await bcrypt.hash(approverPassword, 12);
    const [user, userCreated] = await User.findOrCreate({
      where: { email: APPROVER_EMAIL },
      defaults: {
        name: APPROVER_NAME,
        passwordHash,
        status: 'ACTIVE',
        mfaEnabled: true,
        mfaMethod: 'TOTP',
        createdBy: ADMIN_USER_ID,
      },
      transaction,
    });
    if (!userCreated && (!user.mfaEnabled || user.status !== 'ACTIVE')) {
      await user.update({ mfaEnabled: true, mfaMethod: 'TOTP', status: 'ACTIVE', updatedBy: ADMIN_USER_ID }, { transaction });
    }

    const [role] = await Role.findOrCreate({
      where: { groupId: GROUP_ID, companyId: COMPANY_ID, name: ROLE_NAME },
      defaults: {
        groupId: GROUP_ID,
        companyId: COMPANY_ID,
        description: 'Papel de teste para validar o fluxo de Compras pós-"Solicitada" (maker-checker) na homologação do Marco 7.',
        isSystem: false,
        createdBy: ADMIN_USER_ID,
      },
      transaction,
    });

    for (const code of PERMISSION_CODES) {
      const permission = await Permission.findOne({ where: { code }, transaction });
      if (!permission) {
        throw new Error(`Permissão "${code}" não encontrada no catálogo — rode as migrations/seed base antes.`);
      }
      await RolePermission.findOrCreate({
        where: { roleId: role.id, permissionId: permission.id },
        defaults: { roleId: role.id, permissionId: permission.id, createdBy: ADMIN_USER_ID },
        transaction,
      });
    }

    await UserMembership.findOrCreate({
      where: { groupId: GROUP_ID, companyId: COMPANY_ID, userId: user.id, roleId: role.id },
      defaults: {
        groupId: GROUP_ID,
        companyId: COMPANY_ID,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        createdBy: ADMIN_USER_ID,
      },
      transaction,
    });

    let secretPlain = null;
    const existingCredential = await MfaCredential.findOne({ where: { userId: user.id }, transaction });
    if (!existingCredential) {
      secretPlain = authenticator.generateSecret();
      await MfaCredential.create(
        {
          userId: user.id,
          groupId: GROUP_ID,
          companyId: COMPANY_ID,
          secretEncrypted: encryptSecret(secretPlain),
          enabled: true,
          confirmedAt: new Date(),
          recoveryCodesHash: [],
          createdBy: ADMIN_USER_ID,
        },
        { transaction }
      );
    }

    await transaction.commit();

    console.log('--- Aprovador de Compras (homologação) pronto ---');
    console.log(`Email: ${APPROVER_EMAIL}`);
    console.log('Senha: a definida em APPROVER_SEED_PASSWORD (não exibida).');
    if (secretPlain) {
      console.log(`Segredo TOTP (cadastre num app autenticador — mostrado SÓ nesta primeira execução): ${secretPlain}`);
      console.log(`Código TOTP atual (válido ~30s, para teste imediato): ${authenticator.generate(secretPlain)}`);
    } else {
      console.log('Segredo TOTP: já existia, preservado (não é re-exibido).');
    }
    process.exit(0);
  } catch (err) {
    await transaction.rollback().catch(() => {});
    console.error('Falha no seed do aprovador de compras:', err.message);
    process.exit(1);
  }
}

// Exporta a lista pro teste test/painelApproverPermissions.test.js usar EXATAMENTE o mesmo
// conjunto — qualquer divergência entre o que o Painel exige e o que o seed concede quebra o
// teste, nunca mais uma rodada de auditoria.
module.exports = { PERMISSION_CODES };

if (require.main === module) {
  main();
}
