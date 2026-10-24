'use strict';

const {
  AiRun,
  Contract,
  ContractParty,
  ContractVersion,
  ContractClause,
  ContractRequirement,
  Guarantee,
  LegalCase,
  LegalCaseParty,
  LegalDeadline,
  EvidencePackage,
  Person,
} = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * NAY Jurídica — Caderno Marco 5 §17, JUR-008 ("IA não decide direito: NAY resume/sugere;
 * decisão jurídica é humana"), JUR-TS-012 ("IA extrai data errada -> não vira crítico sem
 * confirmação"), Guia §10 ("NAY pode resumir diferenças") e DoD "NAY jurídica com confirmação
 * humana em ações críticas".
 *
 * RULE-BASED/determinística (mesma decisão da NAY Estoque/Obras/Financeira: sem LLM contratado
 * nesta fase), sobre dados reais do banco, sob o RLS da empresa do contexto. SOMENTE LEITURA:
 * não altera contrato (nem assinado nem rascunho), não cria prazo, não aprova cláusula, não
 * exclui prova. A única escrita é a auditoria da execução em "ai"."ai_runs".
 *
 * Toda saída cita as fontes (tabela + id + hash quando houver) e traz o aviso de que não é
 * conclusão jurídica definitiva.
 */

const AGENT_NAME = 'NAY_JURIDICA';
const AVISO = 'Não é conclusão jurídica definitiva; requer validação profissional. A NAY Jurídica só resume e sugere — não altera contrato, não cria prazo e não exclui prova.';
const MAX_TEXT = 20000;

async function logRun(tenant, actorUserId, inputSummary, toolCallsJson, outputSummary, transaction) {
  const run = await AiRun.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      userId: actorUserId || null,
      agentName: AGENT_NAME,
      inputSummary,
      toolCallsJson: { method: 'RULE_BASED', ...toolCallsJson },
      outputSummary,
      status: 'COMPLETED',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  return run.id;
}

// Os modelos mapeiam createdAt para o atributo 'created_at'.
const createdOf = (x) => (x && x.get ? x.get('created_at') || x.get('createdAt') : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

async function loadContract(contractId, transaction) {
  const contract = contractId ? await Contract.findByPk(contractId, { transaction }) : null;
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  return contract;
}

async function loadCase(caseId, transaction) {
  const legalCase = caseId ? await LegalCase.findByPk(caseId, { transaction }) : null;
  if (!legalCase) throw AppError.notFound('Processo jurídico não encontrado.', 'LEGAL_CASE_NOT_FOUND');
  return legalCase;
}

async function personNames(ids, transaction) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const people = await Person.findAll({ where: { id: unique }, attributes: ['id', 'legalName', 'preferredName'], transaction });
  return new Map(people.map((p) => [p.id, p.preferredName || p.legalName]));
}

/** Resumo do contrato: status, partes, versão vigente + hash, garantias, documentos faltantes, prazos abertos. */
async function summarizeContract(tenant, contractId, actorUserId, transaction) {
  const contract = await loadContract(contractId, transaction);
  const [parties, versions, guarantees, requirements, cases] = await Promise.all([
    ContractParty.findAll({ where: { contractId }, transaction }),
    ContractVersion.findAll({ where: { contractId }, order: [['versionNumber', 'DESC']], transaction }),
    Guarantee.findAll({ where: { contractId }, order: [['created_at', 'ASC']], transaction }),
    ContractRequirement.findAll({ where: { contractId }, transaction }),
    LegalCase.findAll({ where: { contractId }, attributes: ['id', 'caseNumber', 'status'], transaction }),
  ]);
  const deadlines = cases.length
    ? await LegalDeadline.findAll({ where: { legalCaseId: cases.map((c) => c.id) }, order: [['dueAt', 'ASC']], transaction })
    : [];
  const names = await personNames([...parties.map((p) => p.personId), ...guarantees.map((g) => g.guarantorPersonId)], transaction);
  const now = new Date();
  const current = versions[0] || null;
  const missing = requirements.filter((r) => r.status === 'PENDING');
  const openDeadlines = deadlines.filter((d) => d.status !== 'DONE');

  const pontosDeAtencao = [];
  if (missing.length) pontosDeAtencao.push(`${missing.length} documento(s) obrigatório(s) pendente(s) no checklist.`);
  if (!current) pontosDeAtencao.push('Contrato sem nenhuma versão de documento.');
  for (const g of guarantees) {
    if (g.status === 'ACTIVE' && g.endsAt && new Date(g.endsAt) < now) pontosDeAtencao.push(`Garantia ${g.guaranteeType} marcada ACTIVE com vigência vencida em ${iso(g.endsAt).slice(0, 10)}.`);
  }
  for (const d of openDeadlines) {
    if (new Date(d.dueAt) < now) pontosDeAtencao.push(`Prazo "${d.description}" vencido em ${iso(d.dueAt).slice(0, 10)}.`);
  }

  const result = {
    agente: 'NAY Jurídica',
    metodo: 'RULE_BASED',
    aviso: AVISO,
    contrato: {
      id: contract.id,
      numero: contract.contractNumber,
      tipo: contract.contractType,
      status: contract.status,
      valorTotal: contract.totalValue !== null ? Number(contract.totalValue) : null,
      vigencia: { inicio: iso(contract.startsAt), fim: iso(contract.endsAt) },
    },
    partes: parties.map((p) => ({ personId: p.personId, nome: names.get(p.personId) || null, papel: p.partyRole })),
    versaoVigente: current
      ? { id: current.id, numero: current.versionNumber, contentHash: current.contentHash, clauseVersionIds: current.clauseVersionIds || [], vigenteDesde: iso(current.effectiveFrom) }
      : null,
    totalVersoes: versions.length,
    garantias: guarantees.map((g) => ({
      id: g.id,
      tipo: g.guaranteeType,
      status: g.status,
      inicio: iso(g.startsAt),
      fim: iso(g.endsAt),
      fiador: g.guarantorPersonId ? names.get(g.guarantorPersonId) || g.guarantorPersonId : null,
      vencida: Boolean(g.endsAt && new Date(g.endsAt) < now),
    })),
    documentosFaltantes: missing.map((r) => ({ id: r.id, codigo: r.requirementCode, descricao: r.description })),
    prazosAbertos: openDeadlines.map((d) => ({ id: d.id, descricao: d.description, vencimento: iso(d.dueAt), status: d.status, vencido: new Date(d.dueAt) < now })),
    pontosDeAtencao,
    fontes: [
      { tabela: 'legal.contracts', id: contract.id },
      ...(current ? [{ tabela: 'legal.contract_versions', id: current.id, contentHash: current.contentHash }] : []),
      { tabela: 'legal.contract_parties', registros: parties.length },
      { tabela: 'legal.guarantees', registros: guarantees.length },
      { tabela: 'legal.contract_requirements', registros: requirements.length },
      { tabela: 'legal.legal_deadlines', registros: deadlines.length },
    ],
  };
  result.aiRunId = await logRun(tenant, actorUserId, `Resumo do contrato ${contract.id}.`, { contractId }, `${pontosDeAtencao.length} ponto(s) de atenção. Nada alterado (JUR-008).`, transaction);
  return result;
}

/** Resumo de processo jurídico: dados, partes, prazos, dossiês, legal hold. */
async function summarizeCase(tenant, caseId, actorUserId, transaction) {
  const legalCase = await loadCase(caseId, transaction);
  const [parties, deadlines, packages] = await Promise.all([
    LegalCaseParty.findAll({ where: { legalCaseId: caseId }, transaction }),
    LegalDeadline.findAll({ where: { legalCaseId: caseId }, order: [['dueAt', 'ASC']], transaction }),
    EvidencePackage.findAll({ where: { legalCaseId: caseId }, order: [['created_at', 'ASC']], transaction }),
  ]);
  const names = await personNames(parties.map((p) => p.personId), transaction);
  const now = new Date();
  const open = deadlines.filter((d) => d.status !== 'DONE');
  const result = {
    agente: 'NAY Jurídica',
    metodo: 'RULE_BASED',
    aviso: AVISO,
    processo: {
      id: legalCase.id,
      numero: legalCase.caseNumber,
      tipo: legalCase.caseType,
      status: legalCase.status,
      fase: legalCase.phase,
      resumo: legalCase.summary,
      contratoId: legalCase.contractId,
      legalHold: Boolean(legalCase.legalHold),
    },
    partes: parties.map((p) => ({ personId: p.personId, nome: names.get(p.personId) || null, papel: p.partyRole })),
    prazosAbertos: open.map((d) => ({ id: d.id, descricao: d.description, vencimento: iso(d.dueAt), vencido: new Date(d.dueAt) < now, responsavel: d.responsibleUserId })),
    prazosConcluidos: deadlines.length - open.length,
    dossies: packages.map((p) => ({ id: p.id, packageHash: p.packageHash, criadoEm: iso(createdOf(p)), itens: Array.isArray(p.manifestJson) ? p.manifestJson.length : 0 })),
    fontes: [
      { tabela: 'legal.legal_cases', id: legalCase.id },
      { tabela: 'legal.case_parties', registros: parties.length },
      { tabela: 'legal.legal_deadlines', registros: deadlines.length },
      { tabela: 'legal.evidence_packages', registros: packages.length },
    ],
  };
  result.aiRunId = await logRun(tenant, actorUserId, `Resumo do processo ${legalCase.id}.`, { legalCaseId: caseId }, `${open.length} prazo(s) aberto(s). Nada alterado (JUR-008).`, transaction);
  return result;
}

function contentLines(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function linesOnlyIn(source, other) {
  const counts = new Map();
  for (const l of other) counts.set(l, (counts.get(l) || 0) + 1);
  const only = [];
  for (const l of source) {
    const c = counts.get(l) || 0;
    if (c > 0) counts.set(l, c - 1);
    else only.push(l);
  }
  return only;
}

function multisetDiff(a, b) {
  return { removed: linesOnlyIn(a, b), added: linesOnlyIn(b, a) };
}

/** Compara duas versões do contrato: cláusulas incluídas/excluídas e linhas alteradas. */
async function compareContractVersions(tenant, contractId, fromNumber, toNumber, actorUserId, transaction) {
  await loadContract(contractId, transaction);
  const from = Number(fromNumber);
  const to = Number(toNumber);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from === to) {
    throw AppError.badRequest('Informe "from" e "to": números de versão inteiros, positivos e diferentes.', 'LEGAL_NAY_COMPARE_VALIDATION');
  }
  const versions = await ContractVersion.findAll({ where: { contractId, versionNumber: [from, to] }, transaction });
  const a = versions.find((v) => v.versionNumber === from);
  const b = versions.find((v) => v.versionNumber === to);
  if (!a || !b) throw AppError.notFound('Versão do contrato não encontrada.', 'LEGAL_CONTRACT_VERSION_NOT_FOUND');
  const ca = Array.isArray(a.clauseVersionIds) ? a.clauseVersionIds : [];
  const cb = Array.isArray(b.clauseVersionIds) ? b.clauseVersionIds : [];
  const clauseIds = [...new Set([...ca, ...cb])];
  const clauses = clauseIds.length ? await ContractClause.findAll({ where: { id: clauseIds }, attributes: ['id', 'code', 'title', 'versionNumber'], transaction }) : [];
  const label = new Map(clauses.map((c) => [c.id, { id: c.id, codigo: c.code, titulo: c.title, versao: c.versionNumber }]));
  const diff = multisetDiff(contentLines(a.content), contentLines(b.content));
  const result = {
    agente: 'NAY Jurídica',
    metodo: 'RULE_BASED',
    aviso: AVISO,
    de: { numero: from, id: a.id, contentHash: a.contentHash },
    para: { numero: to, id: b.id, contentHash: b.contentHash },
    hashIgual: a.contentHash === b.contentHash,
    clausulasIncluidas: cb.filter((id) => !ca.includes(id)).map((id) => label.get(id) || { id }),
    clausulasExcluidas: ca.filter((id) => !cb.includes(id)).map((id) => label.get(id) || { id }),
    linhasRemovidas: diff.removed,
    linhasIncluidas: diff.added,
    fontes: [
      { tabela: 'legal.contract_versions', id: a.id, contentHash: a.contentHash },
      { tabela: 'legal.contract_versions', id: b.id, contentHash: b.contentHash },
    ],
  };
  result.aiRunId = await logRun(tenant, actorUserId, `Comparação v${from} x v${to} do contrato ${contractId}.`, { contractId, from, to }, `${result.linhasRemovidas.length} linha(s) removida(s), ${result.linhasIncluidas.length} incluída(s).`, transaction);
  return result;
}

/** Sugestão de minuta: só cláusulas HOMOLOGADAS (ativas; com condição, só se aprovada). */
async function suggestClauses(tenant, filters, actorUserId, transaction) {
  const where = { isActive: true };
  if (filters && filters.category) where.category = String(filters.category);
  const clauses = await ContractClause.findAll({ where, order: [['category', 'ASC'], ['code', 'ASC']], transaction });
  const homologadas = clauses.filter((c) => !c.conditionJson || c.conditionStatus === 'APPROVED');
  const foraDaSugestao = clauses.length - homologadas.length;
  const result = {
    agente: 'NAY Jurídica',
    metodo: 'RULE_BASED',
    aviso: AVISO,
    criterio: 'Somente cláusulas ativas da biblioteca; cláusula condicional só entra se a condição estiver aprovada por outra pessoa.',
    clausulasSugeridas: homologadas.map((c) => ({ id: c.id, codigo: c.code, titulo: c.title, categoria: c.category, versao: c.versionNumber, condicional: Boolean(c.conditionJson) })),
    clausulasNaoHomologadasOmitidas: foraDaSugestao,
    fontes: [{ tabela: 'legal.contract_clauses', registros: clauses.length }],
  };
  result.aiRunId = await logRun(tenant, actorUserId, 'Sugestão de minuta com a biblioteca homologada.', { category: where.category || null }, `${homologadas.length} cláusula(s) sugerida(s); ${foraDaSugestao} omitida(s) por não homologada(s).`, transaction);
  return result;
}

function addBusinessDays(date, days) {
  const d = new Date(date);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

/** Extrai prazos de um texto como SUGESTÃO — nunca cria LegalDeadline (JUR-TS-012). */
async function suggestDeadlines(tenant, payload, actorUserId, transaction) {
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) throw AppError.badRequest('Informe "text" com o trecho de onde extrair prazos.', 'LEGAL_NAY_TEXT_REQUIRED');
  if (text.length > MAX_TEXT) throw AppError.badRequest(`"text" aceita até ${MAX_TEXT} caracteres.`, 'LEGAL_NAY_TEXT_TOO_LONG');
  if (payload.legalCaseId) await loadCase(payload.legalCaseId, transaction);
  const reference = payload.referenceDate ? new Date(payload.referenceDate) : new Date();
  if (Number.isNaN(reference.getTime())) throw AppError.badRequest('"referenceDate" inválida.', 'LEGAL_NAY_TEXT_REQUIRED');

  const sugestoes = [];
  const snippet = (idx, len) => text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + len + 60)).replace(/\s+/g, ' ').trim();
  for (const m of text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)) {
    const [, dd, mm, yyyy] = m;
    const due = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 15, 0, 0));
    if (due.getUTCMonth() !== Number(mm) - 1) continue;
    sugestoes.push({ tipo: 'DATA_EXPLICITA', trecho: snippet(m.index, m[0].length), vencimentoSugerido: due.toISOString(), natureza: 'EXTRAIDO' });
  }
  for (const m of text.matchAll(/prazo\s+de\s+(\d{1,3})\s+dias(\s+úteis|\s+uteis|\s+corridos)?/gi)) {
    const n = Number(m[1]);
    const uteis = /teis/i.test(m[2] || '');
    const due = uteis ? addBusinessDays(reference, n) : new Date(reference.getTime() + n * 86400000);
    sugestoes.push({ tipo: uteis ? 'PRAZO_DIAS_UTEIS' : 'PRAZO_DIAS_CORRIDOS', dias: n, trecho: snippet(m.index, m[0].length), vencimentoSugerido: due.toISOString(), natureza: 'ESTIMADO', baseDeCalculo: reference.toISOString() });
  }
  const result = {
    agente: 'NAY Jurídica',
    metodo: 'RULE_BASED',
    aviso: AVISO,
    sugestoes: sugestoes.map((s) => ({
      ...s,
      status: 'PENDING_CONFIRMATION',
      critico: false,
      confirmacao: 'Prazo só passa a existir quando uma pessoa o cadastra em POST /legal/cases/:id/deadlines com origem (sourceDocument/sourceEvent) e responsável.',
    })),
    prazosCriados: 0,
    fontes: [{ origem: 'texto informado', caracteres: text.length, legalCaseId: payload.legalCaseId || null }],
  };
  result.aiRunId = await logRun(tenant, actorUserId, 'Extração de prazos de texto (sugestão).', { legalCaseId: payload.legalCaseId || null, chars: text.length }, `${sugestoes.length} sugestão(ões) PENDING_CONFIRMATION; 0 prazo criado (JUR-TS-012).`, transaction);
  return result;
}

/** Dossiê organizado por fatos e fontes: linha do tempo + arquivos com sha256. */
async function organizeDossier(tenant, caseId, actorUserId, transaction) {
  const legalCase = await loadCase(caseId, transaction);
  const [deadlines, packages] = await Promise.all([
    LegalDeadline.findAll({ where: { legalCaseId: caseId }, transaction }),
    EvidencePackage.findAll({ where: { legalCaseId: caseId }, transaction }),
  ]);
  const versions = legalCase.contractId
    ? await ContractVersion.findAll({ where: { contractId: legalCase.contractId }, attributes: ['id', 'versionNumber', 'contentHash', 'created_at'], transaction })
    : [];
  const fatos = [
    { data: iso(createdOf(legalCase)), fato: `Processo aberto (${legalCase.caseType}).`, fonte: { tabela: 'legal.legal_cases', id: legalCase.id } },
    ...versions.map((v) => ({ data: iso(createdOf(v)), fato: `Versão ${v.versionNumber} do contrato vinculado.`, fonte: { tabela: 'legal.contract_versions', id: v.id, sha256: v.contentHash } })),
    ...deadlines.map((d) => ({ data: iso(createdOf(d)), fato: `Prazo cadastrado: ${d.description} (vence ${iso(d.dueAt).slice(0, 10)}, ${d.status}).`, fonte: { tabela: 'legal.legal_deadlines', id: d.id, origem: d.sourceDocument || d.sourceEvent || null } })),
    ...packages.map((p) => ({ data: iso(createdOf(p)), fato: `Dossiê gerado com ${Array.isArray(p.manifestJson) ? p.manifestJson.length : 0} item(ns).`, fonte: { tabela: 'legal.evidence_packages', id: p.id, sha256: p.packageHash } })),
  ].sort((x, y) => String(x.data).localeCompare(String(y.data)));
  const arquivos = [];
  for (const p of packages) {
    for (const item of Array.isArray(p.manifestJson) ? p.manifestJson : []) {
      arquivos.push({ pacoteId: p.id, tipo: item.type, descricao: item.description, referenciaId: item.referenceId || null, sha256: item.hash || null });
    }
  }
  const result = {
    agente: 'NAY Jurídica',
    metodo: 'RULE_BASED',
    aviso: AVISO,
    processoId: legalCase.id,
    legalHold: Boolean(legalCase.legalHold),
    fatos,
    arquivos,
    fontes: [
      { tabela: 'legal.legal_cases', id: legalCase.id },
      { tabela: 'legal.legal_deadlines', registros: deadlines.length },
      { tabela: 'legal.evidence_packages', registros: packages.length },
      { tabela: 'legal.contract_versions', registros: versions.length },
    ],
  };
  result.aiRunId = await logRun(tenant, actorUserId, `Dossiê organizado do processo ${legalCase.id}.`, { legalCaseId: caseId }, `${fatos.length} fato(s), ${arquivos.length} arquivo(s). Nenhuma prova alterada.`, transaction);
  return result;
}

module.exports = {
  summarizeContract,
  summarizeCase,
  compareContractVersions,
  suggestClauses,
  suggestDeadlines,
  organizeDossier,
  AGENT_NAME,
};
