'use strict';

/**
 * M5-32 — testes ADVERSARIAIS do módulo Jurídico/Contratos.
 *
 * Cada teste é uma tentativa GENUÍNA de abuso contra o domínio jurídico — não é caminho feliz
 * invertido: id de contrato/caso de outro tenant, chamada direta de service pulando a máquina
 * de estados, adulteração de hash direto no banco, payload malicioso, corrida real entre duas
 * transações commitadas. Tudo roda contra o banco real, pelo mesmo caminho de RLS da aplicação
 * (SET LOCAL app.group_id/app.company_id/app.user_id).
 *
 * NÃO duplica o que já existe: ADV-08 (webhook de assinatura duplicado/fora de ordem, em
 * homologacaoEvidencias.test.js), HOM-001 (gates de SIGNING/SIGNED), M5-01 (render ignora
 * cláusula desativada), M5-21 (DAMAGED exige responsibleParty), M5-28/M5-29 (cadeia de
 * custódia e adulteração simples do export), M5-27 (escalonamento) e os M5-10/M5-12/M5-33/M5-34
 * de test/marco5.batch2.test.js.
 */

const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const contractAmendmentsService = require('../src/features/legal/contractAmendments.service');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../src/features/legal/contractTemplates.service');
const signaturesService = require('../src/features/legal/signatures.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const {
  Company,
  Contract,
  ContractVersion,
  Person,
  File,
  EvidencePackageAccessLog,
} = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- helpers ---------------------------------------------------------------------------------

async function createNeighborCompany(transaction, suffix) {
  return Company.create(
    { groupId: tenant.groupId, name: `QA ADV Legal — Empresa vizinha ${suffix}`, status: 'ACTIVE' },
    { transaction }
  );
}

/** Troca o contexto de empresa dentro da transação já aberta (o "atacante" autenticado na
 *  empresa vizinha) e restaura o contexto original ao final. */
async function asCompany(transaction, companyId, fn) {
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: companyId }, transaction });
  try {
    return await fn();
  } finally {
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  }
}

async function createPerson(transaction, label) {
  return Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `${label} ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createDocumentFile(transaction, prefix = 'adv-legal') {
  const suffix = uniqueSuffix();
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `${prefix}/${suffix}.pdf`,
      fileName: `${prefix}-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createProperty(transaction) {
  const suffix = uniqueSuffix();
  return propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, title: `ADV Imóvel ${suffix}`, internalCode: `ADV-${suffix}`, propertyType: 'RESIDENTIAL' },
    tenant.userId,
    transaction
  );
}

async function createLeaseWithParties(transaction) {
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
    tenant.userId,
    transaction
  );
  const landlord = await createPerson(transaction, 'ADV Locador');
  const lessee = await createPerson(transaction, 'ADV Locatário');
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, transaction);
  return { contract, landlord, lessee };
}

async function createContractWithVersion(transaction, content) {
  const { contract, landlord, lessee } = await createLeaseWithParties(transaction);
  await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
  const file = await createDocumentFile(transaction);
  const version = await contractVersionsService.createContractVersion(
    contract.id,
    { content, documentFileId: file.id },
    tenant.userId,
    transaction
  );
  return { contract, version, landlord, lessee, file };
}

// --- 1..3: isolamento entre tenants (RLS real) -----------------------------------------------

test('ADV-L01: contrato de outra empresa não vaza nem por consulta direta por id (RLS bloqueia, não é filtro de aplicação)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const vizinha = await createNeighborCompany(transaction, suffix);

    await asCompany(transaction, vizinha.id, async () => {
      const vazou = await Contract.findByPk(contract.id, { transaction });
      assert.equal(vazou, null, 'o RLS não pode devolver contrato de outra empresa nem por id exato');

      await assert.rejects(
        () => contractsService.getContract(contract.id, transaction),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_NOT_FOUND');
          return true;
        }
      );

      // Listar também não pode "escapar" pelo filtro.
      const listados = await contractsService.listContracts(transaction, {});
      assert.ok(!listados.some((c) => c.id === contract.id));
    });
  });
});

test('ADV-L02: aditivo para contrato de OUTRA empresa é impossível (o contrato simplesmente não existe para o atacante)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const vizinha = await createNeighborCompany(transaction, suffix);

    await asCompany(transaction, vizinha.id, async () => {
      await assert.rejects(
        () =>
          contractAmendmentsService.createAmendment(
            contract.id,
            { reason: 'Aditivo forjado pelo tenant vizinho', changes: [{ field: 'totalValue', oldValue: 1000, newValue: 1 }] },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_NOT_FOUND');
          return true;
        }
      );
    });

    // E nenhum aditivo foi criado do lado da vítima.
    const amendments = await contractAmendmentsService.listAmendments(contract.id, transaction);
    assert.equal(amendments.length, 0);
  });
});

test('ADV-L03: garantia e entrega de chaves de contrato de outro tenant são bloqueadas (group/company vêm do contrato, não do payload)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, lessee } = await createLeaseWithParties(transaction);
    const vizinha = await createNeighborCompany(transaction, suffix);

    await asCompany(transaction, vizinha.id, async () => {
      await assert.rejects(
        () =>
          guaranteesService.createGuarantee(
            contract.id,
            { guaranteeType: 'DEPOSIT', value: 1 },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_NOT_FOUND');
          return true;
        }
      );

      // Ataque específico das chaves: o payload traz o group/company do ATACANTE junto com o
      // contrato da vítima — antes do fix, a linha era criada sem o contrato ser lido.
      await assert.rejects(
        () =>
          keyDeliveriesService.createKeyDelivery(
            { groupId: tenant.groupId, companyId: vizinha.id, contractId: contract.id, deliveredToPersonId: lessee.id },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_NOT_FOUND');
          return true;
        }
      );
    });

    const deliveries = await keyDeliveriesService.listKeyDeliveries(transaction, { contractId: contract.id });
    assert.equal(deliveries.length, 0, 'nenhuma entrega de chaves pode ter sido plantada');
  });
});

// --- 4..6: máquina de estados e ciclo de vida -------------------------------------------------

test('ADV-L04: pular a máquina de estados (DRAFT -> ACTIVE e DRAFT -> SIGNED direto) é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);

    for (const alvo of ['ACTIVE', 'SIGNED', 'SIGNING', 'APPROVED']) {
      await assert.rejects(
        () => contractsService.transitionContractStatus(contract, alvo, tenant.userId, transaction),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_INVALID_TRANSITION');
          return true;
        },
        `DRAFT -> ${alvo} precisa ser rejeitado`
      );
    }

    const persisted = await contractsService.getContract(contract.id, transaction);
    assert.equal(persisted.status, 'DRAFT');
  });
});

test('ADV-L05: contrato CANCELADO não pode ser mandado para assinatura nem ressuscitado por transição', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { contract, version, landlord } = await createContractWithVersion(transaction, `ADV-L05 corpo ${suffix}`);
    await contractsService.transitionContractStatus(contract, 'CANCELLED', tenant.userId, transaction);
    assert.equal(contract.status, 'CANCELLED');

    // Ataque 1: solicitar assinatura de um documento de contrato já cancelado.
    await assert.rejects(
      () => signaturesService.initiateSignature(version.id, [landlord.id], tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_SIGNATURE_CONTRACT_CANCELLED');
        return true;
      }
    );
    const criadas = await signaturesService.listSignaturesByContractVersion(version.id, transaction);
    assert.equal(criadas.length, 0, 'nenhuma assinatura pode ter sido criada para contrato cancelado');

    // Ataque 2: "ressuscitar" o contrato cancelado por qualquer transição.
    for (const alvo of ['ACTIVE', 'SIGNING', 'DRAFT', 'APPROVED']) {
      await assert.rejects(
        () => contractsService.transitionContractStatus(contract, alvo, tenant.userId, transaction),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_INVALID_TRANSITION');
          return true;
        }
      );
    }
  });
});

test('ADV-L06: correctContractData não é porta dos fundos para trocar status/tenant do contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const vizinha = await createNeighborCompany(transaction, suffix);
    const { contract } = await createLeaseWithParties(transaction);

    for (const payload of [
      { status: 'ACTIVE', reason: 'ativação por fora da máquina de estados' },
      { companyId: vizinha.id, reason: 'mudar o contrato de empresa' },
      { groupId: tenant.groupId, reason: 'mudar o grupo' },
      { id: crypto.randomUUID(), reason: 'trocar a identidade do registro' },
    ]) {
      await assert.rejects(
        () => contractsService.correctContractData(contract.id, payload, tenant.userId, transaction),
        (err) => {
          assert.equal(err.code, 'LEGAL_CONTRACT_CORRECTION_FIELD_NOT_ALLOWED');
          return true;
        },
        `campo proibido não pode ser "corrigido": ${Object.keys(payload).filter((k) => k !== 'reason')}`
      );
    }

    const persisted = await contractsService.getContract(contract.id, transaction);
    assert.equal(persisted.status, 'DRAFT');
    assert.equal(persisted.companyId, tenant.companyId);
  });
});

// --- 7..9: integridade da versão contratual (append-only + hash) -------------------------------

test('ADV-L07: adulterar o content_hash de uma ContractVersion direto no banco é REJEITADO pelo trigger append-only', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { version } = await createContractWithVersion(transaction, `ADV-L07 corpo original ${suffix}`);
    const hashOriginal = version.contentHash;

    // O UPDATE roda dentro de um SAVEPOINT: a exceção do trigger aborta o savepoint, não a
    // transação do teste (que segue viva para conferir que a linha continua intacta).
    await assert.rejects(
      () =>
        sequelize.transaction({ transaction }, (savepoint) =>
          sequelize.query('UPDATE legal.contract_versions SET content_hash = :h WHERE id = :id', {
            replacements: { h: 'f'.repeat(64), id: version.id },
            transaction: savepoint,
          })
        ),
      (err) => {
        assert.match(String(err.message), /append-only|UPDATE não é permitido/i);
        return true;
      },
      'UPDATE direto na tabela de versões contratuais precisa estourar no banco'
    );

    // A linha continua intacta — o hash do documento assinado não foi trocado.
    const persisted = await ContractVersion.findByPk(version.id, { transaction });
    assert.equal(persisted.contentHash, hashOriginal);
  });
});

test('ADV-L08: adulteração do CONTEÚDO do documento é detectável — o hash recalculado deixa de bater com o gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const conteudoOriginal = `ADV-L08 — Aluguel mensal de R$ 2.000,00 ${suffix}`;
    const { version } = await createContractWithVersion(transaction, conteudoOriginal);

    // O "documento" entregue depois foi adulterado (valor do aluguel trocado).
    const conteudoAdulterado = conteudoOriginal.replace('R$ 2.000,00', 'R$ 200,00');
    const hashAdulterado = contractVersionsService.computeContentHash(conteudoAdulterado);

    assert.equal(contractVersionsService.computeContentHash(conteudoOriginal), version.contentHash);
    assert.notEqual(hashAdulterado, version.contentHash, 'documento trocado tem que produzir hash diferente');

    // LIMITAÇÃO HONESTA E DOCUMENTADA: a tabela guarda o HASH, não o conteúdo — a detecção
    // depende de reapresentar o documento (o arquivo em document_file_id) e reprocessar o hash.
    // O que o sistema garante é que o hash gravado é imutável (ADV-L07), então qualquer
    // divergência aponta para o documento, nunca para o registro.
    assert.ok(version.documentFileId, 'a versão precisa apontar para o arquivo real que sustenta o hash');
  });
});

test('ADV-L09: "reverter" uma ContractVersion é impossível — nova versão nunca reescreve a anterior e número repetido é barrado pelo banco', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { contract, version } = await createContractWithVersion(transaction, `ADV-L09 v1 ${suffix}`);
    const hashV1 = version.contentHash;

    const file2 = await createDocumentFile(transaction);
    const v2 = await contractVersionsService.createContractVersion(
      contract.id,
      { content: `ADV-L09 v2 ${suffix}`, documentFileId: file2.id },
      tenant.userId,
      transaction
    );
    assert.equal(v2.versionNumber, 2);

    // A v1 continua exatamente como era (nada de "voltar atrás" sobrescrevendo).
    const v1Persisted = await ContractVersion.findByPk(version.id, { transaction });
    assert.equal(v1Persisted.contentHash, hashV1);
    assert.equal(v1Persisted.versionNumber, 1);

    // A superfície pública do service não oferece update/delete de versão — por construção.
    assert.equal(typeof contractVersionsService.updateContractVersion, 'undefined');
    assert.equal(typeof contractVersionsService.deleteContractVersion, 'undefined');

    // Ataque real: plantar uma segunda "versão 1" com outro hash para "virar" a versão vigente.
    await assert.rejects(
      () =>
        ContractVersion.create(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            contractId: contract.id,
            versionNumber: 1,
            documentFileId: file2.id,
            contentHash: contractVersionsService.computeContentHash('versão 1 forjada'),
            effectiveFrom: new Date(),
            createdBy: tenant.userId,
            updatedBy: tenant.userId,
          },
          { transaction }
        ),
      (err) => {
        assert.match(String(err.message), /unique|contract_versions_contract_version_unique/i);
        return true;
      }
    );
  });
});

// --- 10..11: payloads maliciosos em vistoria ---------------------------------------------------

test('ADV-L10: item DAMAGED com orçamento negativo, string maliciosa ou NaN é rejeitado na aplicação (não chega ao banco)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const property = await createProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_OUT' },
      tenant.userId,
      transaction
    );

    const payloadsMaliciosos = [
      -1,
      -0.01,
      "100'; DROP TABLE legal.inspection_items; --",
      'muito caro',
      'NaN',
      Number.NaN,
      Infinity,
      '',
      {},
    ];

    for (const estimatedBudget of payloadsMaliciosos) {
      await assert.rejects(
        () =>
          inspectionsService.addInspectionItem(
            inspection.id,
            {
              itemName: `Janela ${suffix}`,
              condition: 'DAMAGED',
              damageDescription: 'Vidro trincado',
              estimatedBudget,
              responsibleParty: 'TENANT',
            },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'LEGAL_INSPECTION_ITEM_VALIDATION');
          return true;
        },
        `estimatedBudget inválido (${JSON.stringify(estimatedBudget)}) tem que ser rejeitado`
      );
    }

    const itens = await inspectionsService.listInspectionItems(inspection.id, transaction);
    assert.equal(itens.length, 0, 'nenhum item inválido pode ter sido gravado');

    // A tabela continua existindo (a "injeção" nunca foi interpretada como SQL).
    const [rows] = await sequelize.query("SELECT to_regclass('legal.inspection_items') AS t", { transaction });
    assert.ok(rows[0].t, 'legal.inspection_items continua existindo');
  });
});

test('ADV-L11: anexar mídia de vistoria com arquivo de outro tenant não vincula nada (o File não existe sob o RLS do atacante)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );
    const item = await inspectionsService.addInspectionItem(
      inspection.id,
      { itemName: `Parede ${suffix}`, condition: 'GOOD' },
      tenant.userId,
      transaction
    );
    const file = await createDocumentFile(transaction, 'adv-l11');
    const vizinha = await createNeighborCompany(transaction, suffix);

    await asCompany(transaction, vizinha.id, async () => {
      await assert.rejects(
        () => inspectionsService.attachInspectionItemMedia(item.id, { fileId: file.id }, tenant.userId, transaction),
        (err) => {
          // O item também é de outro tenant: seja pelo item, seja pelo arquivo, o ataque morre
          // antes de criar qualquer vínculo.
          assert.ok(['LEGAL_INSPECTION_ITEM_NOT_FOUND', 'LEGAL_INSPECTION_MEDIA_FILE_NOT_FOUND'].includes(err.code), err.code);
          return true;
        }
      );
    });

    const midias = await inspectionsService.listInspectionItemMedia(item.id, transaction);
    assert.equal(midias.length, 0);
  });
});

// --- 12..14: processos, prazos e dossiê ---------------------------------------------------------

test('ADV-L12: processo jurídico com fase inválida é rejeitado na criação E na atualização (não vira fase "livre" por acidente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();

    await assert.rejects(
      () =>
        legalCasesService.createLegalCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', phase: 'SENTENCA_FAVORAVEL', summary: `ADV-L12 ${suffix}` },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_VALIDATION');
        return true;
      }
    );

    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', phase: 'INITIAL_PETITION', summary: `ADV-L12 ok ${suffix}` },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => legalCasesService.updateLegalCase(legalCase.id, { phase: "CLOSED'; DROP TABLE legal.legal_cases; --" }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_VALIDATION');
        return true;
      }
    );

    const persisted = await legalCasesService.getLegalCase(legalCase.id, transaction);
    assert.equal(persisted.phase, 'INITIAL_PETITION', 'a fase não pode ter sido alterada pela tentativa inválida');
  });
});

test('ADV-L13: prazo jurídico de outro tenant não pode ser lido nem "empurrado" para o futuro', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `ADV-L13 ${suffix}`, responsibleUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    const dueAtOriginal = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Contestação ${suffix}`, dueAt: dueAtOriginal },
      tenant.userId,
      transaction
    );
    const vizinha = await createNeighborCompany(transaction, suffix);

    await asCompany(transaction, vizinha.id, async () => {
      await assert.rejects(
        () => legalDeadlinesService.getLegalDeadline(deadline.id, transaction),
        (err) => {
          assert.equal(err.code, 'LEGAL_DEADLINE_NOT_FOUND');
          return true;
        }
      );
      // Ataque real: "apagar" o vencimento de um prazo alheio jogando a data pra frente / marcando DONE.
      await assert.rejects(
        () =>
          legalDeadlinesService.updateLegalDeadline(
            deadline.id,
            { status: 'DONE', dueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'LEGAL_DEADLINE_NOT_FOUND');
          return true;
        }
      );
      const listados = await legalDeadlinesService.listLegalDeadlines(transaction, {});
      assert.ok(!listados.some((d) => d.id === deadline.id));
    });

    const persisted = await legalDeadlinesService.getLegalDeadline(deadline.id, transaction);
    assert.equal(persisted.status, 'PENDING');
    assert.equal(new Date(persisted.dueAt).toISOString(), dueAtOriginal.toISOString());
    assert.equal(legalDeadlinesService.computeSeverity(persisted), 'OVERDUE');
  });
});

test('ADV-L14: exportar/visualizar dossiê de um caso de outro tenant falha e NÃO deixa rastro na cadeia de custódia do dono', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `ADV-L14 ${suffix}` },
      tenant.userId,
      transaction
    );
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [{ type: 'CONTRACT', description: `Prova sigilosa ${suffix}`, referenceId: null, hash: 'abc' }],
      tenant.userId,
      transaction
    );
    const vizinha = await createNeighborCompany(transaction, suffix);

    await asCompany(transaction, vizinha.id, async () => {
      for (const attack of [
        () => evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, transaction),
        () => evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction),
      ]) {
        await assert.rejects(attack, (err) => {
          assert.equal(err.code, 'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND');
          return true;
        });
      }
      // E o atacante também não cria dossiê novo em cima do caso alheio.
      await assert.rejects(
        () =>
          evidencePackagesService.createEvidencePackage(
            legalCase.id,
            [{ type: 'FORGED', description: 'dossiê plantado' }],
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'LEGAL_CASE_NOT_FOUND');
          return true;
        }
      );
    });

    const acessos = await EvidencePackageAccessLog.count({ where: { evidencePackageId: pkg.id }, transaction });
    assert.equal(acessos, 0, 'tentativa de acesso negada não pode poluir a cadeia de custódia');
  });
});

test('ADV-L15: export de dossiê reescrito de forma AUTOCONSISTENTE (manifesto + hash) é desmascarado pelo hash gravado no banco', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'COLLECTION', summary: `ADV-L15 ${suffix}` },
      tenant.userId,
      transaction
    );
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [{ type: 'RECEIPT', description: `Comprovante de pagamento ${suffix}`, referenceId: null, hash: 'orig' }],
      tenant.userId,
      transaction
    );
    const exported = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction);

    // O adversário edita o manifesto E recalcula o packageHash dentro do arquivo — o export
    // fica internamente coerente (é a limitação já documentada no service).
    const forjado = JSON.parse(JSON.stringify(exported));
    forjado.manifest[0].description = 'Comprovante de pagamento (INEXISTENTE — inserido pelo adversário)';
    forjado.packageHash = evidencePackagesService.computePackageHash(forjado.manifest);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(forjado).valid, true, 'export forjado é autoconsistente — por isso o hash do banco é obrigatório');

    // A verificação que vale: confrontar com o hash PERSISTIDO (fonte da verdade).
    const contraBanco = evidencePackagesService.verifyEvidencePackageIntegrity(forjado, pkg.packageHash);
    assert.equal(contraBanco.valid, false, 'confrontado com o hash do banco, o dossiê forjado é reprovado');
    assert.notEqual(contraBanco.recomputedHash, pkg.packageHash);

    // O export legítimo continua passando na mesma verificação.
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(exported, pkg.packageHash).valid, true);
  });
});

// --- 16: templates -----------------------------------------------------------------------------

test('ADV-L16: cláusula DESATIVADA vinculada a um template não entra no documento gerado nem no hash da versão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `ADV-L16 Modelo ${suffix}`, contractType: 'LEASE' },
      tenant.userId,
      transaction
    );
    const vigente = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code: `ADV-L16-OK-${suffix}`, title: 'Prazo de vigência', bodyText: 'Vigência de 30 meses.', category: 'GENERAL' },
      tenant.userId,
      transaction
    );
    const revogada = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code: `ADV-L16-REVOGADA-${suffix}`, title: 'Cláusula revogada', bodyText: `TEXTO-REVOGADO-${suffix} — multa de 12 aluguéis.`, category: 'PAYMENT' },
      tenant.userId,
      transaction
    );
    await contractClausesService.deactivateClause(revogada.id, tenant.userId, transaction);

    // Ataque: vincular ao modelo uma cláusula JÁ DESATIVADA, esperando que ela seja renderizada.
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: vigente.id }, tenant.userId, transaction);
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: revogada.id }, tenant.userId, transaction);

    const rendered = await contractTemplatesService.renderTemplate(template.id, transaction);
    assert.ok(rendered.content.includes('Vigência de 30 meses.'));
    assert.ok(!rendered.content.includes(`TEXTO-REVOGADO-${suffix}`), 'texto revogado não pode entrar no documento');
    assert.ok(!rendered.clauses.some((c) => c.contractClauseId === revogada.id));

    // E o hash da versão gerada a partir do modelo reflete APENAS o texto vigente.
    const { contract } = await createLeaseWithParties(transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    const file = await createDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: rendered.content, documentFileId: file.id },
      tenant.userId,
      transaction
    );
    assert.equal(version.contentHash, crypto.createHash('sha256').update(rendered.content).digest('hex'));
  });
});

// --- 17: concorrência real (duas transações commitadas disputando o MESMO contrato) -------------

/** Transação REAL com commit — necessária para provar a corrida entre duas transações. */
async function withCommittedTenantTransaction(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

test('ADV-L17: duas transações simultâneas transicionando o MESMO contrato para estados DIFERENTES — só uma vence e o estado final é consistente', async () => {
  let contractId = null;
  try {
    // Dados commitados de verdade (a corrida só existe entre transações distintas).
    const criado = await withCommittedTenantTransaction(async (t) => {
      const contract = await contractsService.createContract(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000, contractNumber: `ADV-L17-${uniqueSuffix()}` },
        tenant.userId,
        t
      );
      const landlord = await createPerson(t, 'ADV-L17 Locador');
      const lessee = await createPerson(t, 'ADV-L17 Locatário');
      await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
      await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, t);
      return contract;
    });
    contractId = criado.id;

    // Dois operadores diferentes, ao mesmo tempo: um avança o contrato, o outro cancela.
    const corrida = async (alvo) =>
      withCommittedTenantTransaction(async (t) => {
        const contract = await contractsService.getContract(contractId, t);
        return contractsService.transitionContractStatus(contract, alvo, tenant.userId, t);
      });

    const resultados = await Promise.allSettled([corrida('DOCUMENTS_PENDING'), corrida('CANCELLED')]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const falhos = resultados.filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, `exatamente uma transição pode vencer a corrida (resultados: ${JSON.stringify(resultados.map((r) => r.status))})`);
    assert.equal(falhos.length, 1);
    assert.match(
      String(falhos[0].reason && falhos[0].reason.name) + String(falhos[0].reason && falhos[0].reason.message),
      /OptimisticLock|lock|Transição de status inválida/i,
      'a perdedora tem que falhar por lock otimista (ou por transição inválida sobre o estado já mudado)'
    );

    // Estado final consistente: exatamente o da vencedora, e o lock_version avançou uma vez só.
    const finalState = await withCommittedTenantTransaction((t) => contractsService.getContract(contractId, t));
    assert.equal(finalState.status, ok[0].value.status);
    assert.ok(['DOCUMENTS_PENDING', 'CANCELLED'].includes(finalState.status));
    assert.equal(finalState.lockVersion, 1, 'só uma escrita pode ter sido aplicada à linha');
  } finally {
    if (contractId) {
      await withCommittedTenantTransaction(async (t) => {
        await sequelize.query('DELETE FROM legal.contract_parties WHERE contract_id = :id', { replacements: { id: contractId }, transaction: t });
        await sequelize.query('DELETE FROM legal.contracts WHERE id = :id', { replacements: { id: contractId }, transaction: t });
      });
    }
  }
});
