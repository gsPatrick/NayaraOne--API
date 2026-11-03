'use strict';
/**
 * Cenários do Marco 5 (Contratos, Locação, Vistorias, Jurídico e Cobrança) — grupos 20 a 39.
 * Mesmas regras de cenarios-marco4.js: HTTP real com os perfis do seed de dois tenants.
 */
module.exports = async function marco5(R) {
  const sfx = String(Date.now()).slice(-7);
  const H = (o) => R.http(o);

  // ---------- preparação ----------
  await H({ id: 'PREP5-1', titulo: 'Preparação: locatário fictício', quem: 'A:gestor', metodo: 'POST', rota: '/people', corpo: { personType: 'PF', legalName: `Locatário Fictício ${sfx}` }, esperado: { status: 201 }, guardar: (b, c) => { c.pe = b.data.id; } });
  await H({ id: 'PREP5-2', titulo: 'Preparação: imóvel fictício', quem: 'A:gestor', metodo: 'POST', rota: '/properties', corpo: { title: `Imóvel Fictício ${sfx}`, internalCode: `IMV-${sfx}`, propertyType: 'RESIDENTIAL' }, esperado: { status: 201 }, guardar: (b, c) => { c.pr = b.data.id; } });

  // ---------- G20 Tipos contratuais e termos ----------
  const tipos = ['SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN', 'CONSTRUCTION'];
  let k = 0;
  for (const tipo of tipos) {
    k += 1;
    await H({ id: `G20-${k}`, grupos: [20], titulo: tipo === 'CONSTRUCTION' ? 'Contrato de obra exige o projeto de obra (regra do tipo)' : `Cria contrato do tipo ${tipo}`, quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: (c) => ({ contractType: tipo, totalValue: 1000 * k, propertyId: c.pr }), esperado: tipo === 'CONSTRUCTION' ? { status: 400, codigo: 'LEGAL_CONTRACT_CONSTRUCTION_PROJECT_REQUIRED' } : { status: 201 }, guardar: (b, c) => { if (b && b.data) c[`ct_${tipo}`] = b.data.id; } });
  }
  await H({ id: 'G20-10', grupos: [20], titulo: 'Tipo inexistente é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: { contractType: 'TIPO_INVENTADO', totalValue: 1 }, esperado: { status: 400 } });
  await H({ id: 'G20-11', grupos: [20, 33], titulo: 'Leitura não cria contrato', quem: 'A:leitura', metodo: 'POST', rota: '/legal/contracts', corpo: { contractType: 'SALE_CASH' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  // contrato de locação principal
  await H({ id: 'PREP5-3', titulo: 'Preparação: contrato de locação com locatário', quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: (c) => ({ contractType: 'LEASE_RESIDENTIAL', totalValue: 1500, propertyId: c.pr }), esperado: { status: 201 }, guardar: (b, c) => { c.ct = b.data.id; } });
  await H({ id: 'PREP5-4', titulo: 'Preparação: parte locatária', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/parties`, corpo: (c) => ({ personId: c.pe, partyRole: 'TENANT' }), esperado: { status: 201 } });

  // ---------- G21 Cláusulas ----------
  await H({ id: 'G21-1', grupos: [21], f: ['F01'], titulo: 'Maker cria cláusula condicional (nasce pendente de aprovação)', quem: 'A:maker', metodo: 'POST', rota: '/legal/clauses', corpo: { code: `COND-${sfx}`, title: 'Fiança', bodyText: 'Obrigações do fiador (texto fictício)', category: 'GUARANTEE', condition: { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] } }, esperado: { status: 201 }, guardar: (b, c) => { c.cl = b.data.id; c.clCode = b.data.code; } });
  await H({ id: 'G21-2', grupos: [21], f: ['F01'], titulo: 'Texto executável na condição é recusado', quem: 'A:maker', metodo: 'POST', rota: '/legal/clauses', corpo: { code: `EXEC-${sfx}`, title: 'x', bodyText: 'x', category: 'GENERAL', condition: 'contractType === "LEASE" && process.exit()' }, esperado: { status: 400, codigo: 'LEGAL_CLAUSE_CONDITION_INVALID' } });
  await H({ id: 'G21-3', grupos: [21], f: ['F01'], titulo: 'Variável inventada na condição é recusada', quem: 'A:maker', metodo: 'POST', rota: '/legal/clauses', corpo: { code: `VAR-${sfx}`, title: 'x', bodyText: 'x', category: 'GENERAL', condition: { match: 'all', rules: [{ variable: 'inventada', operator: 'eq', value: 'x' }] } }, esperado: { status: 400, codigo: 'LEGAL_CLAUSE_CONDITION_INVALID' } });
  await H({ id: 'G21-4', grupos: [21], f: ['F01'], titulo: 'Maker (sem legal:approve) não aprova a condição', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/clauses/${c.cl}/approve-condition`, corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'G21-5', grupos: [21, 17], f: ['F01'], titulo: 'Checker do tenant B não aprova a condição do tenant A', quem: 'B:checker', metodo: 'POST', rota: (c) => `/legal/clauses/${c.cl}/approve-condition`, corpo: {}, esperado: { status: 404 } });
  await H({ id: 'G21-6', grupos: [21], f: ['F01'], titulo: 'Checker do tenant A aprova a condição criada pelo maker', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/clauses/${c.cl}/approve-condition`, corpo: {}, esperado: { status: 200 } });
  await H({ id: 'G21-7', grupos: [21], f: ['F01'], titulo: 'Checker cria a própria cláusula condicional', quem: 'A:checker', metodo: 'POST', rota: '/legal/clauses', corpo: { code: `CKC-${sfx}`, title: 'Fiança do checker', bodyText: 'Texto fictício', category: 'GUARANTEE', condition: { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] } }, esperado: { status: 201 }, guardar: (b, c) => { c.cl2 = b.data.id; } });
  await H({ id: 'G21-8', grupos: [21], f: ['F01'], titulo: 'Checker não aprova a condição que ele mesmo criou', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/clauses/${c.cl2}/approve-condition`, corpo: {}, esperado: { status: 403, codigo: 'LEGAL_CLAUSE_CONDITION_SELF_APPROVAL_BLOCKED' } });
  await H({ id: 'G21-9', grupos: [21], titulo: 'Nova versão da cláusula preserva a anterior', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/clauses/${c.clCode}/versions`, corpo: { bodyText: 'Texto da versão 2.' }, esperado: { status: 201 } });
  await H({ id: 'G21-10', grupos: [21], titulo: 'Histórico de versões da cláusula', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/clauses/${c.clCode}/versions`, esperado: { status: 200 } });

  // ---------- G22 Versões, hashes e assinaturas ----------
  await H({ id: 'G22-1', grupos: [22], titulo: 'Envia o documento (arquivo fictício)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: { fileName: 'contrato.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(`Contrato fictício ${sfx}`).toString('base64'), category: 'generic' }, esperado: { status: 201 }, guardar: (b, c) => { c.f1 = b.data.id; } });
  await H({ id: 'G22-2', grupos: [22], titulo: 'Versão sem arquivo do documento é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/versions`, corpo: { content: 'Texto integral' }, esperado: { status: 400, codigo: 'LEGAL_CONTRACT_VERSION_DOCUMENT_REQUIRED' } });
  await H({ id: 'G22-3', grupos: [22], titulo: 'Versão com documento recebe hash de conteúdo', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/versions`, corpo: (c) => ({ content: `Texto integral do contrato fictício ${sfx}`, documentFileId: c.f1 }), esperado: { status: 201 }, guardar: (b, c) => { c.v1 = b.data.id; } });
  await H({ id: 'G22-4', grupos: [22], titulo: 'Versão é imutável: não existe rota de alteração', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/contract-versions/${c.v1}`, corpo: { content: 'adulterado' }, esperado: { status: 404 } });
  await H({ id: 'G22-5', grupos: [22], titulo: 'Assinatura manual fora de SIGNING é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contract-versions/${c.v1}/manual-signatures`, corpo: (c) => ({ personId: c.pe, evidenceFileId: c.f1 }), esperado: { status: 409, codigo: 'LEGAL_SIGNATURE_CONTRACT_NOT_SIGNING' } });
  await H({ id: 'G22-6', grupos: [22], titulo: 'Assinatura manual sem evidência é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contract-versions/${c.v1}/manual-signatures`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_MANUAL_SIGNATURE_EVIDENCE_REQUIRED' } });
  await H({ id: 'G22-7', grupos: [22, 33], titulo: 'Leitura não registra assinatura', quem: 'A:leitura', metodo: 'POST', rota: (c) => `/legal/contract-versions/${c.v1}/signatures`, corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  // ---------- G23 Checklist ----------
  await H({ id: 'G23-1', grupos: [23], titulo: 'Gera o checklist documental do contrato de locação', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/requirements/generate`, corpo: {}, esperado: { status: 201 }, guardar: (b, c) => { c.req1 = b.data[0].id; } });
  await H({ id: 'G23-2', grupos: [23, 24], titulo: 'Avançar com documento pendente é recusado', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/transition`, corpo: { targetStatus: 'DOCUMENTS_PENDING' }, esperado: { status: 409, codigo: 'LEGAL_REQUIREMENTS_PENDING' } });
  await H({ id: 'G23-3', grupos: [23], titulo: 'Dispensa sem permissão legal:waive é recusada', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/requirements/${c.req1}/waive`, corpo: { reason: 'teste' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'G23-4', grupos: [23], titulo: 'Dispensa com permissão e motivo', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/requirements/${c.req1}/waive`, corpo: { reason: 'Dispensado em teste de conferência' }, esperado: { status: 200 } });

  // ---------- G24 Máquina de estados ----------
  await H({ id: 'G24-1', grupos: [24], titulo: 'Salto proibido DRAFT → ACTIVE é recusado', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct_SALE_CASH}/transition`, corpo: { targetStatus: 'ACTIVE' }, esperado: { status: 409 } });
  await H({ id: 'G24-2', grupos: [24], titulo: 'Maker (sem legal:approve) não faz transição', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct_SALE_CASH}/transition`, corpo: { targetStatus: 'DOCUMENTS_PENDING' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'G24-3', grupos: [24, 33], titulo: 'Tenant B não altera o contrato do tenant A', quem: 'B:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/transition`, corpo: { targetStatus: 'DOCUMENTS_PENDING' }, esperado: { status: 404 } });
  await H({ id: 'G24-4', grupos: [24], titulo: 'Linha do tempo do contrato', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/contracts/${c.ct}/timeline`, esperado: { status: 200 } });

  // ---------- G25 Garantias ----------
  await H({ id: 'G25-1', grupos: [25], titulo: 'Tipo de garantia inválido é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/guarantees`, corpo: { guaranteeType: 'SECURITY_DEPOSIT', amount: 3000 }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'G25-2', grupos: [25], titulo: 'Cria caução com vigência', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/guarantees`, corpo: { guaranteeType: 'DEPOSIT', amount: 3000, startsAt: '2026-01-01', endsAt: '2030-01-01' }, esperado: { status: 201 }, guardar: (b, c) => { c.g1 = b.data.id; } });
  await H({ id: 'G25-3', grupos: [25], titulo: 'Atualiza a garantia', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/guarantees/${c.g1}`, corpo: { amount: 3500 }, esperado: { status: 200 } });
  await H({ id: 'G25-4', grupos: [25], titulo: 'Lista garantias por tipo', quem: 'A:leitura', metodo: 'GET', rota: '/legal/guarantees?guaranteeType=DEPOSIT', esperado: { status: 200 } });

  // ---------- G26 Entrega de chaves ----------
  await H({ id: 'G26-1', grupos: [26], titulo: 'Cria a entrega de chaves', quem: 'A:gestor', metodo: 'POST', rota: '/legal/key-deliveries', corpo: (c) => ({ contractId: c.ct, deliveredToPersonId: c.pe }), esperado: { status: 201 }, guardar: (b, c) => { c.kd = b.data.id; } });
  await H({ id: 'G26-2', grupos: [26], titulo: 'Termo de entrega gerado pelo servidor (pré-visualização)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/key-deliveries/${c.kd}/term-preview`, esperado: { status: 200 } });
  await H({ id: 'G26-3', grupos: [26], titulo: 'Liberar sem os requisitos (checklist, vistoria, assinatura) é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/key-deliveries/${c.kd}/release`, corpo: {}, esperado: { status: 409 } });
  await H({ id: 'G26-4', grupos: [26, 33], titulo: 'Leitura não libera chaves', quem: 'A:leitura', metodo: 'POST', rota: (c) => `/legal/key-deliveries/${c.kd}/release`, corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  // ---------- G27 Vistorias ----------
  await H({ id: 'G27-1', grupos: [27], titulo: 'Cria vistoria de entrada', quem: 'A:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: (c) => ({ propertyId: c.pr, contractId: c.ct, inspectionType: 'ENTRY' }), esperado: { status: 201 }, guardar: (b, c) => { c.ins = b.data.id; } });
  await H({ id: 'G27-2', grupos: [27], titulo: 'Adiciona item', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/inspections/${c.ins}/items`, corpo: { itemName: 'Sala', condition: 'GOOD' }, esperado: { status: 201 } });
  await H({ id: 'G27-3', grupos: [27], titulo: 'Conclui a vistoria', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/inspections/${c.ins}/complete`, corpo: {}, esperado: { status: 200 } });
  await H({ id: 'G27-4', grupos: [27], titulo: 'Assinar a vistoria exige MFA (recusado sem MFA)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/inspections/${c.ins}/sign`, corpo: {}, esperado: { status: 403 } });
  await H({ id: 'G27-5', grupos: [27], titulo: 'Revisão só existe para laudo assinado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/inspections/${c.ins}/revisions`, corpo: { reason: 'correção' }, esperado: { status: 409, codigo: 'LEGAL_INSPECTION_REVISION_NOT_SIGNED' } });
  await H({ id: 'G27-6', grupos: [27], titulo: 'Lista vistorias por tipo', quem: 'A:leitura', metodo: 'GET', rota: '/legal/inspections?inspectionType=ENTRY', esperado: { status: 200 } });

  // ---------- G28 Utilidades ----------
  await H({ id: 'G28-1', grupos: [28], titulo: 'Obrigações de utilidade do tenant', quem: 'A:gestor', metodo: 'GET', rota: '/billing/utility-obligations', esperado: { status: 200 } });
  await H({ id: 'G28-0', grupos: [28, 33], titulo: 'Perfil leitura sem billing:read não lê utilidades', quem: 'A:leitura', metodo: 'GET', rota: '/billing/utility-obligations', esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'G28-2', grupos: [28], titulo: 'Conta de utilidade sem obrigação é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-accounts', corpo: {}, esperado: { status: 400, codigo: 'UTILITY_ACCOUNT_VALIDATION' } });
  await H({ id: 'G28-3', grupos: [28], titulo: 'Concluir troca de titularidade inexistente', quem: 'A:gestor', metodo: 'POST', rota: '/billing/ownership-transfer-tasks/00000000-0000-4000-8000-000000000000/complete', corpo: {}, esperado: { status: 404 } });

  // ---------- G29 Aditivos e notificações ----------
  await H({ id: 'G29-1', grupos: [29], titulo: 'Aditivo sem alterações é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/amendments`, corpo: { reason: 'Aditivo' }, esperado: { status: 400, codigo: 'LEGAL_CONTRACT_AMENDMENT_VALIDATION' } });
  await H({ id: 'G29-2', grupos: [29], titulo: 'Cria aditivo numerado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/amendments`, corpo: { reason: 'Reajuste do valor', changes: [{ field: 'totalValue', oldValue: 1500, newValue: 1600 }] }, esperado: { status: 201 } });
  await H({ id: 'G29-3', grupos: [29], titulo: 'Cria notificação formal', quem: 'A:gestor', metodo: 'POST', rota: '/legal/notices', corpo: (c) => ({ contractId: c.ct, channel: 'EMAIL', subject: 'Aviso', content: 'Aviso fictício' }), esperado: { status: 201 }, guardar: (b, c) => { c.nt = b.data.id; } });
  await H({ id: 'G29-4', grupos: [29], titulo: 'Envio exige MFA e revisão humana (recusado)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.nt}/send`, corpo: {}, esperado: { status: 403 } });

  // ---------- G30 Processos e prazos ----------
  await H({ id: 'G30-1', grupos: [30], titulo: 'Cria processo', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: (c) => ({ caseType: 'LITIGATION', title: `Processo ${sfx}`, contractId: c.ct }), esperado: { status: 201 }, guardar: (b, c) => { c.cs = b.data.id; } });
  await H({ id: 'G30-2', grupos: [30], titulo: 'Prazo sem origem é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.cs}/deadlines`, corpo: { description: 'Prazo', dueAt: '2030-01-01' }, esperado: { status: 400, codigo: 'LEGAL_DEADLINE_SOURCE_REQUIRED' } });
  await H({ id: 'G30-3', grupos: [30], titulo: 'Prazo com origem rastreável', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.cs}/deadlines`, corpo: { description: 'Manifestação', dueAt: '2030-01-01', sourceDocument: 'Intimação fictícia' }, esperado: { status: 201 } });
  await H({ id: 'G30-4', grupos: [30], titulo: 'Lista de prazos', quem: 'A:leitura', metodo: 'GET', rota: '/legal/deadlines', esperado: { status: 200 } });

  // ---------- G31 Dossiê, custódia e legal hold ----------
  await H({ id: 'G31-1', grupos: [31], titulo: 'Dossiê sem itens no manifesto é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.cs}/evidence-packages`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_EVIDENCE_PACKAGE_VALIDATION' } });
  await H({ id: 'G31-2', grupos: [31], titulo: 'Gera dossiê com manifesto e hash', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.cs}/evidence-packages`, corpo: (c) => ({ manifestItems: [{ type: 'CONTRACT', description: 'Contrato de locação fictício', id: c.ct }] }), esperado: { status: 201 }, guardar: (b, c) => { c.ev = b.data.id; } });
  await H({ id: 'G31-3', grupos: [31], titulo: 'Exporta o dossiê (id de exportação e custódia do acesso)', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.ev}/export`, esperado: { status: 200 } });
  await H({ id: 'G31-4', grupos: [31], titulo: 'Log de acessos do dossiê', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.ev}/access-log`, esperado: { status: 200 } });
  await H({ id: 'G31-5', grupos: [31], titulo: 'Legal hold no processo', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.cs}/legal-hold`, corpo: { legalHold: true, reason: 'Preservação por litígio fictício' }, esperado: { status: 200 } });
  await H({ id: 'G31-6', grupos: [31, 39, 17], f: ['F05'], titulo: 'Tenant B não lê o dossiê do tenant A', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.ev}`, esperado: { status: 404 } });

  // ---------- G32 NAY jurídica ----------
  await H({ id: 'G32-1', grupos: [32], titulo: 'NAY jurídica: resumo do contrato (só resume e sugere)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/contracts/${c.ct}/summary`, esperado: { status: 200 } });
  await H({ id: 'G32-2', grupos: [32], titulo: 'NAY: sugestões de cláusulas homologadas', quem: 'A:leitura', metodo: 'GET', rota: '/legal/nay/clause-suggestions', esperado: { status: 200 } });
  await H({ id: 'G32-3', grupos: [32], titulo: 'NAY: sugestão de prazos a partir de texto (não cria prazo)', quem: 'A:leitura', metodo: 'POST', rota: '/legal/nay/deadline-suggestions', corpo: { text: 'Intime-se a parte para manifestação no prazo de 15 dias a contar de 20/10/2026.' }, esperado: { status: 200 } });
  await H({ id: 'G32-4', grupos: [32], titulo: 'NAY: dossiê por fatos do processo', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/cases/${c.cs}/dossier`, esperado: { status: 200 } });
  await H({ id: 'G32-5', grupos: [32], titulo: 'Tenant B não vê o resumo do contrato de A', quem: 'B:leitura', metodo: 'GET', rota: (c) => `/legal/nay/contracts/${c.ct}/summary`, esperado: { status: 404 } });

  // ---------- G33 Eventos, permissões e RLS ----------
  await H({ id: 'G33-1', grupos: [33, 17], titulo: 'Tenant B lista contratos: nenhum do tenant A', quem: 'B:gestor', metodo: 'GET', rota: '/legal/contracts', esperado: { status: 200 } });
  await H({ id: 'G33-2', grupos: [33], titulo: 'Leitura lê o contrato', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/contracts/${c.ct}`, esperado: { status: 200 } });

  // ---------- G34 Cobrança por competência ----------
  await H({ id: 'G34-1', grupos: [34], titulo: 'Cronograma sem componentes é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: (c) => ({ contractId: c.ct, dueDate: '2030-01-10', period: '2030-01' }), esperado: { status: 400, codigo: 'BILLING_SCHEDULE_VALIDATION' } });
  await H({ id: 'G34-2', grupos: [34], titulo: 'Lista cronogramas de cobrança', quem: 'A:gestor', metodo: 'GET', rota: '/billing/schedules', esperado: { status: 200 } });

  // ---------- G35 Multa, juros, régua e acordo ----------
  await H({ id: 'G35-1', grupos: [35], titulo: 'Régua de cobrança (padrão do Motor de Regras)', quem: 'A:gestor', metodo: 'GET', rota: '/billing/collection-cadence', esperado: { status: 200 } });
  await H({ id: 'G35-2', grupos: [35], titulo: 'Publicar versão da régua exige billing:cadence:manage: leitura recusada', quem: 'A:leitura', metodo: 'POST', rota: '/billing/collection-cadence/versions', corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'G35-3', grupos: [35], titulo: 'Caso de cobrança sem cronograma: 404', quem: 'A:gestor', metodo: 'POST', rota: '/billing/collection-cases', corpo: (c) => ({ contractId: c.ct }), esperado: { status: 404, codigo: 'BILLING_SCHEDULE_NOT_FOUND' } });

  // ---------- G36 Reajuste ----------
  await H({ id: 'G36-1', grupos: [36], titulo: 'Reajuste sem índice e valor anterior é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/rent-adjustments', corpo: (c) => ({ contractId: c.ct }), esperado: { status: 400, codigo: 'RENT_ADJUSTMENT_VALIDATION' } });
  await H({ id: 'G36-2', grupos: [36], titulo: 'Lista reajustes', quem: 'A:gestor', metodo: 'GET', rota: '/billing/rent-adjustments', esperado: { status: 200 } });

  // ---------- G37 Aluguel garantido e antecipação ----------
  await H({ id: 'G37-1', grupos: [37], titulo: 'Aluguel garantido sem início de cobertura é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/guaranteed-rent', corpo: (c) => ({ contractId: c.ct }), esperado: { status: 400, codigo: 'GUARANTEED_RENT_VALIDATION' } });
  await H({ id: 'G37-2', grupos: [37], titulo: 'Antecipação sem meses e principal é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/rent-advances', corpo: (c) => ({ contractId: c.ct }), esperado: { status: 400, codigo: 'RENT_ADVANCE_VALIDATION' } });
  await H({ id: 'G37-3', grupos: [37], titulo: 'Produtos separados: listas independentes', quem: 'A:gestor', metodo: 'GET', rota: '/billing/guaranteed-rent', esperado: { status: 200 } });
  await H({ id: 'G37-4', grupos: [37], titulo: 'Pagar antecipação inexistente por leitura é recusado', quem: 'A:leitura', metodo: 'POST', rota: '/billing/rent-advances/00000000-0000-4000-8000-000000000000/pay', corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  // ---------- G38 Encerramento ----------
  await H({ id: 'G38-1', grupos: [38], titulo: 'Elegibilidade de encerramento lista as pendências críticas', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/billing/contracts/${c.ct}/closeout-eligibility`, esperado: { status: 200 } });
  await H({ id: 'G38-2', grupos: [38], titulo: 'Encerrar com pendência crítica é bloqueado pelo gate único', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/billing/contracts/${c.ct}/closeout`, corpo: {}, esperado: { status: 409, codigo: 'CLOSEOUT_BLOCKED' } });
  await H({ id: 'G38-3', grupos: [38], titulo: 'Fechar o contrato pela rota de status também passa pelo gate', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ct}/close`, corpo: { reason: 'encerramento de teste' }, esperado: { status: 409 } });
  await H({ id: 'G38-4', grupos: [38], titulo: 'Contrato inexistente não é elegível', quem: 'A:gestor', metodo: 'GET', rota: '/billing/contracts/00000000-0000-4000-8000-000000000000/closeout-eligibility', esperado: { status: 404 } });
};
