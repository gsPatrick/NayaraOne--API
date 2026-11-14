'use strict';
/**
 * Preparação do ambiente descartável da captura do Marco 4 (fixtures pela camada de serviço/modelo
 * com RLS real, role de runtime). Nada aqui é prova: cada fixture fica listada em `preparacao[]`
 * da saída. A prova é sempre o passo HTTP que usa a fixture.
 */
const crypto = require('node:crypto');
const { sequelize } = require('../../src/models');

/** Transação de tenant com SET LOCAL (mesmo contexto que a API usa). `companyId` pode trocar a empresa. */
function inTenant(tenant, fn, companyId) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: companyId || tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

function hojeBR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

async function concederPermissoes(R) {
  const M = require('../../src/models');
  const A = R.tenant('A:gestor');
  await R.preparar('PREP-S0', 'Perfil CI GESTOR da empresa A recebe audit:read e governance:dlp:export (leitura da trilha e exportação governada); novo login por POST /auth/login', () =>
    inTenant(A, async (t) => {
      const role = await M.Role.findOne({ where: { groupId: A.groupId, companyId: A.companyId, name: 'CI GESTOR' }, transaction: t });
      for (const code of ['audit:read', 'governance:dlp:export']) {
        const perm = await M.Permission.findOne({ where: { code }, transaction: t });
        if (!perm) throw new Error(`permissão ${code} ausente do catálogo`);
        await M.RolePermission.findOrCreate({ where: { roleId: role.id, permissionId: perm.id }, defaults: { roleId: role.id, permissionId: perm.id }, transaction: t });
      }
    }));
  await R.login('A', 'gestor');
}

async function prepararAmbiente(R, sfx) {
  const M = require('../../src/models');
  const settings = require('../../src/features/settings/settings.service');
  const files = require('../../src/features/files/files.service');
  const A = R.tenant('A:gestor');
  const c = R.ctx;
  c.sfx = sfx;
  c.hoje = hojeBR();
  c.webhookSecret = crypto.randomBytes(24).toString('hex'); // só em memória

  await R.preparar('PREP-S1', 'Empresa A: provedor bancário sandbox e segredo do webhook (configuração, sem dinheiro real)', () =>
    inTenant(A, async (t) => {
      await settings.upsertSetting('finance.payment_provider', 'sandbox', A, A.userId, t);
      await settings.upsertSetting('finance.bank_payment_webhook_secret', c.webhookSecret, A, A.userId, t);
    }));

  await R.preparar('PREP-S2', 'Segunda empresa do MESMO grupo A (destino das operações entre empresas) com conta bancária própria', () =>
    inTenant(A, async (t) => {
      const co = await M.Company.create({ groupId: A.groupId, name: `CI — Empresa Fictícia A2 (Construção) ${sfx}`, status: 'ACTIVE' }, { transaction: t });
      c.companyA2 = co.id;
    }));
  await R.preparar('PREP-S3', 'Conta bancária da empresa A2 (Banco do Brasil fictício)', () =>
    inTenant(A, async (t) => {
      const ba = await M.BankAccount.create({ groupId: A.groupId, companyId: c.companyA2, bankCode: '001', agency: '0001', accountNumber: `A2-BB-${sfx}`, status: 'ACTIVE' }, { transaction: t });
      c.baA2 = ba.id;
    }, c.companyA2));

  await R.preparar('PREP-S4', 'Contas bancárias da empresa A já fora do resfriamento (ACTIVE): Locação/Sicredi, Construção/BB e NC Serviços', () =>
    inTenant(A, async (t) => {
      const mk = (bankCode, nome) => M.BankAccount.create({ groupId: A.groupId, companyId: A.companyId, bankCode, agency: '0001', accountNumber: `${nome}-${sfx}`, pixKey: `${nome.toLowerCase()}-${sfx}@exemplo.test`, status: 'ACTIVE' }, { transaction: t });
      c.baLoc = (await mk('748', 'LOC')).id;
      c.baObra = (await mk('001', 'OBRA')).id;
      c.baNc = (await mk('104', 'NCSB')).id;
      c.baRec = (await mk('748', 'CONC')).id;
      c.baFav = (await mk('341', 'FAVORECIDO')).id;
      c.baFav2 = (await mk('341', 'FAVORECIDO2')).id;
      c.baPag = (await mk('748', 'PAGAMENTOS')).id;
    }));

  await R.preparar('PREP-S5', 'Pessoas fictícias (proprietário e locatário), imóvel e contrato de locação ACTIVE com as partes', () =>
    inTenant(A, async (t) => {
      const props = require('../../src/features/properties/properties.service');
      const owner = await M.Person.create({ groupId: A.groupId, companyId: A.companyId, personType: 'PF', legalName: `Proprietário fictício ${sfx}`, createdBy: A.userId, updatedBy: A.userId }, { transaction: t });
      const tenantP = await M.Person.create({ groupId: A.groupId, companyId: A.companyId, personType: 'PF', legalName: `Locatário fictício ${sfx}`, createdBy: A.userId, updatedBy: A.userId }, { transaction: t });
      const property = await props.createProperty({ groupId: A.groupId, companyId: A.companyId, title: `Imóvel fictício ${sfx}`, internalCode: `IMV-${sfx}`, propertyType: 'RESIDENTIAL' }, A.userId, t);
      const contract = await M.Contract.create({ groupId: A.groupId, companyId: A.companyId, propertyId: property.id, contractType: 'LEASE', contractNumber: `LOC-${sfx}`, status: 'ACTIVE', createdBy: A.userId, updatedBy: A.userId }, { transaction: t });
      await M.ContractParty.create({ groupId: A.groupId, companyId: A.companyId, contractId: contract.id, personId: owner.id, partyRole: 'LANDLORD' }, { transaction: t });
      await M.ContractParty.create({ groupId: A.groupId, companyId: A.companyId, contractId: contract.id, personId: tenantP.id, partyRole: 'TENANT' }, { transaction: t });
      const ownerAcc = await M.BankAccount.create({ groupId: A.groupId, companyId: A.companyId, ownerPersonId: owner.id, bankCode: '748', agency: '0001', accountNumber: `PROP-${sfx}`, status: 'ACTIVE' }, { transaction: t });
      Object.assign(c, { owner: owner.id, locatario: tenantP.id, property: property.id, contract: contract.id, baOwner: ownerAcc.id });
    }));

  await R.preparar('PREP-S6', 'Comprovantes fictícios (PDF) para baixa manual, transferência entre empresas e desconto de repasse', () =>
    inTenant(A, async (t) => {
      const up = (n) => files.uploadFile({ groupId: A.groupId, companyId: A.companyId, fileName: `comprovante-ficticio-${n}.pdf`, mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4\nCOMPROVANTE FICTICIO ${n} ${sfx}\n%%EOF`).toString('base64'), category: 'generic' }, A.userId, t);
      c.fileIc = (await up('intercompany')).id;
      c.fileManual = (await up('baixa-manual')).id;
      c.fileDesconto = (await up('desconto-repasse')).id;
      c.fileManual2 = (await up('baixa-manual-2')).id;
      c.fileManual3 = (await up('baixa-manual-3')).id;
      c.fileBanco = (await up('troca-dados-bancarios')).id;
      c.fileRep = (await up('pagamento-repasse')).id;
    }));
}

/** Assina o corpo bruto do webhook bancário com o segredo da empresa (HMAC-SHA256). */
function assinarWebhook(ctx, corpo) {
  const bruto = JSON.stringify(corpo);
  return { bruto, assinatura: `sha256=${crypto.createHmac('sha256', ctx.webhookSecret).update(Buffer.from(bruto)).digest('hex')}` };
}

module.exports = { inTenant, concederPermissoes, prepararAmbiente, assinarWebhook, hojeBR };
