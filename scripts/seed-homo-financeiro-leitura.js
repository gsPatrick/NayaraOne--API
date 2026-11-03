'use strict';

require('dotenv').config();

const { sequelize, Role, Permission, RolePermission } = require('../src/models');

/**
 * R8 (reconferência ao vivo 20/10/2026) — homologação. Cria (idempotente) APENAS o papel
 * "HOMO QA — Financeiro (somente leitura)": consulta tudo do Financeiro e as leituras que as
 * telas dele usam para mostrar nomes, e nenhuma ação (sem criar, editar, liquidar, aprovar,
 * conciliar, conta bancária nem plano de contas).
 *
 * NÃO cria usuário, senha nem MFA. Para usar o papel, o operador cria o usuário pela tela
 * Usuários (ele segue todas as regras do sistema, inclusive MFA) e atribui este papel pela
 * tela de vínculos. Ver o passo a passo no relatório da correção.
 *
 * Uso: node scripts/seed-homo-financeiro-leitura.js   (recusa produção)
 */
const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';
const ROLE_NAME = 'HOMO QA — Financeiro (somente leitura)';

const PERMISSION_CODES = [
  'finance:read', // todas as telas e relatórios do Financeiro (somente consulta)
  'people:read', // nome de pessoas (favorecido, proprietário, corretor) nas listas
  'users:read', // nome de usuários (aprovador, responsável) nas listas
  'companies:read', // nome da empresa no topo e nas transferências entre empresas
  'properties:read', // imóvel citado em lançamentos, comissões e repasses
];

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query(
      "SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: GROUP_ID, c: COMPANY_ID, u: ADMIN_USER_ID }, transaction }
    );

    const [role, created] = await Role.findOrCreate({
      where: { groupId: GROUP_ID, companyId: COMPANY_ID, name: ROLE_NAME },
      defaults: {
        groupId: GROUP_ID,
        companyId: COMPANY_ID,
        description: 'Papel de teste: consulta o Financeiro sem nenhuma ação (somente leitura).',
        isSystem: false,
        createdBy: ADMIN_USER_ID,
      },
      transaction,
    });

    const wanted = await Permission.findAll({ where: { code: PERMISSION_CODES }, transaction });
    if (wanted.length !== PERMISSION_CODES.length) {
      const found = new Set(wanted.map((p) => p.code));
      throw new Error(`Permissões ausentes no catálogo: ${PERMISSION_CODES.filter((c) => !found.has(c)).join(', ')}`);
    }
    const wantedIds = new Set(wanted.map((p) => p.id));
    // Remove do papel o que não está na lista (o seed é a fonte da verdade do papel).
    const links = await RolePermission.findAll({ where: { roleId: role.id }, transaction });
    for (const link of links) if (!wantedIds.has(link.permissionId)) await link.destroy({ transaction });
    for (const p of wanted) {
      await RolePermission.findOrCreate({
        where: { roleId: role.id, permissionId: p.id },
        defaults: { roleId: role.id, permissionId: p.id, createdBy: ADMIN_USER_ID },
        transaction,
      });
    }
    await transaction.commit();
    console.log(`${created ? 'Criado' : 'Já existia'}: papel "${ROLE_NAME}" (${role.id}) com ${wanted.length} permissões: ${PERMISSION_CODES.join(', ')}.`);
  } catch (err) {
    await transaction.rollback();
    throw err;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { ROLE_NAME, PERMISSION_CODES };
