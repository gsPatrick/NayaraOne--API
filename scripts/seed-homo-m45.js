'use strict';

require('dotenv').config();

const { sequelize, Company, UserMembership, BankAccount, FinancialEntry, PaymentIntent, CostCenter, BankPaymentProviderRouting } = require('../src/models');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const costCentersService = require('../src/features/finance/costCenters.service');
const { registrarAuditoria } = require('../src/engines/audit/auditLog.service');

/**
 * Seed de homologação M45 (auditoria 19/10/2026) — idempotente, SEM dinheiro real.
 *
 * F8 — Intercompany: o admin do grupo só tinha vínculo na "Empresa Dev"; a regra (finance:read
 * também na empresa de destino) está correta, então para testar cria-se uma empresa de destino
 * de homologação no MESMO grupo, com o admin vinculado (papel ADMIN) e uma conta bancária ativa.
 *
 * F9 — Intenções de pagamento: cria 2 lançamentos a pagar de homologação com intenções nos
 * estados SUBMITTED ("Em trânsito no banco") e SUBMITTING ("Envio ao banco incerto"), com
 * externalSubmissionId do provedor SANDBOX. "Consultar banco" consulta o adapter sandbox
 * (simulação, confirma e registra SANDBOX_CONFIRMED — nunca banco real). O estado é gravado
 * direto (o envio real exige aprovação por outra pessoa + MFA, que este seed não simula) e
 * auditado como seed de homologação.
 *
 * Uso: node scripts/seed-homo-m45.js   (nunca em produção: recusa se DEPLOY_ENVIRONMENT=production)
 */

const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';
const DEST_COMPANY_NAME = 'HOMO QA — M45 Intercompany Destino';
const SEED_TAG = 'HOMO M45';

async function setCtx(companyId, t) {
  await sequelize.query('SELECT set_config(\'app.company_id\', :c, true)', { replacements: { c: companyId }, transaction: t });
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: GROUP_ID }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: ADMIN_USER_ID }, transaction: t });
    await setCtx(COMPANY_ID, t);

    const adminMembership = await UserMembership.findOne({ where: { userId: ADMIN_USER_ID, companyId: COMPANY_ID, status: 'ACTIVE' }, transaction: t });
    if (!adminMembership) throw new Error('Vínculo do admin na Empresa Dev não encontrado.');

    // ---------------- F8 ----------------
    let dest = await Company.findOne({ where: { groupId: GROUP_ID, name: DEST_COMPANY_NAME }, transaction: t });
    if (!dest) {
      dest = await Company.create({ groupId: GROUP_ID, name: DEST_COMPANY_NAME, legalName: DEST_COMPANY_NAME, status: 'ACTIVE', createdBy: ADMIN_USER_ID }, { transaction: t });
    }
    await setCtx(dest.id, t);
    await UserMembership.findOrCreate({
      where: { groupId: GROUP_ID, companyId: dest.id, userId: ADMIN_USER_ID, roleId: adminMembership.roleId },
      defaults: { groupId: GROUP_ID, companyId: dest.id, userId: ADMIN_USER_ID, roleId: adminMembership.roleId, status: 'ACTIVE', createdBy: ADMIN_USER_ID },
      transaction: t,
    });
    let destAccount = await BankAccount.findOne({ where: { companyId: dest.id }, transaction: t });
    if (!destAccount) {
      destAccount = await bankAccountsService.createBankAccount(
        { groupId: GROUP_ID, companyId: dest.id, bankCode: '001', agency: '4545', accountNumber: 'M45-DEST-1' },
        ADMIN_USER_ID, t
      );
      destAccount.status = 'ACTIVE';
      await destAccount.save({ transaction: t });
    }
    await setCtx(COMPANY_ID, t);

    // ---------------- F9 ----------------
    const created = [];
    for (const target of ['SUBMITTED', 'SUBMITTING']) {
      const baseDescription = `${SEED_TAG} — pagamento sandbox ${target === 'SUBMITTED' ? 'em trânsito' : 'envio incerto'}`;
      // M45-RECONF: idempotente por "existe intenção ABERTA neste estado". Se a anterior já foi
      // consultada/resolvida (Executada), cria uma nova rodada numerada para o próximo reteste.
      const { Op } = require('sequelize');
      const previous = await FinancialEntry.findAll({ where: { companyId: COMPANY_ID, description: { [Op.like]: `${baseDescription}%` } }, transaction: t });
      const openIntent = previous.length
        ? await PaymentIntent.findOne({ where: { financialEntryId: previous.map((e) => e.id), status: target }, transaction: t })
        : null;
      if (openIntent) continue;
      const round = previous.length + 1;
      const description = round === 1 ? baseDescription : `${baseDescription} (rodada ${round})`;
      let account = await BankAccount.findOne({ where: { companyId: COMPANY_ID, accountNumber: 'M45-SANDBOX' }, transaction: t });
      if (!account) {
        account = await bankAccountsService.createBankAccount(
          { groupId: GROUP_ID, companyId: COMPANY_ID, bankCode: '001', agency: '4545', accountNumber: 'M45-SANDBOX', pixKey: 'homolog-m45@nayaraone.dev' },
          ADMIN_USER_ID, t
        );
        account.status = 'ACTIVE';
        await account.save({ transaction: t });
      }
      const cc = (await CostCenter.findOne({ where: { companyId: COMPANY_ID, code: 'HOMO-M45' }, transaction: t }))
        || (await costCentersService.createCostCenter({ groupId: GROUP_ID, companyId: COMPANY_ID, code: 'HOMO-M45', name: `${SEED_TAG} — homologação` }, ADMIN_USER_ID, t));
      const entry = await financialEntriesService.createFinancialEntry(
        {
          groupId: GROUP_ID, companyId: COMPANY_ID, bankAccountId: account.id, entryType: 'DEBIT', nature: 'PAYABLE',
          amount: target === 'SUBMITTED' ? 123.45 : 67.89, description, dueAt: new Date(), competenceMonth: new Date().toISOString().slice(0, 7),
          idempotencyKey: round === 1 ? `homo-m45-${target}` : `homo-m45-${target}-${round}`, costCenterId: cc.id,
        },
        ADMIN_USER_ID, t
      );
      const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, ADMIN_USER_ID, t);
      const row = await PaymentIntent.findByPk(intent.id, { transaction: t });
      const before = row.toJSON();
      row.status = target;
      row.paymentMethod = 'PIX';
      row.idempotencyKey = round === 1 ? `homo-m45-${target}` : `homo-m45-${target}-${round}`;
      row.externalSubmissionId = target === 'SUBMITTED' ? `sandbox-homo-m45-${target}${round === 1 ? '' : `-${round}`}` : null;
      row.externalStatus = target === 'SUBMITTED' ? 'PENDING_EXTERNAL' : null;
      row.submittedAt = new Date();
      row.uncertainSince = target === 'SUBMITTING' ? new Date() : null;
      row.updatedBy = ADMIN_USER_ID;
      await row.save({ transaction: t });
      if (row.externalSubmissionId) {
        // M45-RECONF F2: sem o roteamento, "Consultar banco" não achava a intenção pelo id externo.
        await BankPaymentProviderRouting.findOrCreate({
          where: { externalSubmissionId: row.externalSubmissionId },
          defaults: { externalSubmissionId: row.externalSubmissionId, paymentIntentId: row.id, groupId: GROUP_ID, companyId: COMPANY_ID },
          transaction: t,
        });
      }
      await registrarAuditoria(
        {
          groupId: GROUP_ID, companyId: COMPANY_ID, actorUserId: ADMIN_USER_ID, action: 'finance.payment_intent.homolog_seed',
          entityType: 'PaymentIntent', entityId: row.id, beforeJson: before, afterJson: row.toJSON(),
          reason: `Seed de homologação M45 (F9): estado ${target} com provedor SANDBOX — sem dinheiro real.`,
        },
        t
      );
      created.push({ target, intentId: row.id, entryId: entry.id });
    }

    await t.commit();
    console.log(JSON.stringify({ destCompanyId: dest.id, destBankAccountId: destAccount.id, intents: created }, null, 2));
  } catch (err) {
    await t.rollback();
    throw err;
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
