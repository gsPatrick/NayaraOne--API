'use strict';

const PDFDocument = require('pdfkit');
const { Person, ContractParty } = require('../../models');
const { getContract } = require('./contracts.service');
const { getContractVersion } = require('./contractVersions.service');

const BRAND_GOLD = '#BE9130';
const BRAND_DARK = '#1F1B16';

// Rótulo em português dos party_role de ContractParty (LANDLORD|TENANT|GUARANTOR|BUYER|SELLER)
// — usado só pra exibição no PDF, não muda a persistência.
const ROLE_LABELS = {
  LANDLORD: 'Locador(a)',
  TENANT: 'Locatário(a)',
  GUARANTOR: 'Fiador(a)',
  BUYER: 'Comprador(a)',
  SELLER: 'Vendedor(a)',
};

/**
 * parseRenderedContent — divide o texto final do contrato (`renderTemplate(...).content`) em
 * blocos: o PRIMEIRO bloco é o título/nome do modelo, os seguintes são as cláusulas.
 *
 * DECISÃO DE ENGENHARIA: `renderTemplate` (contractTemplates.service.js) monta `content` como
 * `[nomeDoTemplate, ...cláusulas].join('\n\n')`, e cada cláusula por sua vez é
 * `"${title}\n${bodyText}"`. Ou seja, o próprio formato de junção já separa os blocos por
 * linha em branco de forma determinística — não precisamos depender de `clauses` (que só traz
 * metadado, sem o bodyText) pra reconstruir título/corpo: basta espelhar o split usado na
 * montagem (`\n\n` entre blocos, primeira linha de cada bloco de cláusula = título). Isso é
 * mais robusto a variáveis (`renderTemplate(templateId, t, variables)`) já substituídas no
 * texto do que tentar casar índice a índice com `clauses`.
 */
function parseRenderedContent(renderedContent) {
  const blocks = String(renderedContent || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const title = blocks.length > 0 ? blocks[0] : 'Contrato';
  const clauses = blocks.slice(1).map((block) => {
    const lines = block.split('\n');
    return { title: lines[0] || '', body: lines.slice(1).join('\n').trim() };
  });

  return { title, clauses };
}

async function loadPartiesForPdf(contractId, transaction) {
  const parties = await ContractParty.findAll({ where: { contractId }, transaction });
  const people = await Person.findAll({ where: { id: parties.map((p) => p.personId) }, transaction });
  const peopleById = new Map(people.map((p) => [p.id, p]));

  return parties.map((party) => {
    const person = peopleById.get(party.personId);
    return {
      role: ROLE_LABELS[party.partyRole] || party.partyRole,
      name: person ? person.legalName : '(pessoa não encontrada)',
      document: person ? person.taxIdNormalized : null,
    };
  });
}

/**
 * generateContractPdf — monta o PDF de representação de uma ContractVersion (identidade visual
 * Nayara One + partes + cláusulas + rodapé de integridade) e retorna o BUFFER em memória, sem
 * persistir nada em disco nem criar registro de File.
 *
 * DECISÃO DE ENGENHARIA (22/09/2026, substitui a abordagem anterior de salvar em
 * uploads/contracts/...): contrato é conteúdo TEXTUAL determinístico — `ContractVersion.content`
 * (ver migration 20260101000179) já é a fonte de verdade persistida (texto renderizado +
 * content_hash calculado sobre ele). O PDF é só uma REPRESENTAÇÃO derivada desse texto: mesmo
 * `content` -> mesmo PDF -> mesmo hash de integridade no rodapé, sempre reconstruível sob
 * demanda. Isso elimina a dependência de storage de binário pra contratos — funciona mesmo sem
 * volume persistente configurado no host (Easypanel/Docker, filesystem efêmero do container),
 * porque nada de binário de contrato precisa sobreviver a um redeploy. Só outras categorias de
 * File que não são regeneráveis a partir de texto (fotos/vídeos de vistoria, documentos de
 * pessoas/imóveis) continuam usando disco de verdade (ver src/utils/diskStorage.js).
 *
 * Chamável tanto pelo endpoint manual (GET /legal/contracts/:id/versions/:versionId/generate-pdf,
 * que devolve o PDF direto na resposta) quanto internamente pelo fluxo de assinatura
 * (ClicksignSignatureAdapter.requestSignature), que precisa do buffer real do PDF pra subir ao
 * provedor — em ambos os casos o PDF é gerado ali na hora e descartado depois de servido.
 */
async function generateContractPdf(contractVersionId, actorUserId, transaction) {
  const version = await getContractVersion(contractVersionId, transaction);
  const contract = await getContract(version.contractId, transaction);
  const parties = await loadPartiesForPdf(contract.id, transaction);
  const { title, clauses } = parseRenderedContent(version.content);

  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cabeçalho/timbre — faixa dourada Nayara One.
    doc.rect(0, 0, doc.page.width, 8).fill(BRAND_GOLD);
    doc.moveDown(1.5);
    doc.fillColor(BRAND_DARK).fontSize(18).font('Helvetica-Bold').text('Nayara One', { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text('Gestão Imobiliária', { align: 'center' });
    doc.moveDown(1);
    doc.strokeColor(BRAND_GOLD).lineWidth(1.5).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(1);

    // Número e título do contrato em destaque.
    doc.fillColor(BRAND_GOLD).fontSize(11).font('Helvetica-Bold').text(`Contrato nº ${contract.contractNumber || contract.id}`);
    doc.fillColor(BRAND_DARK).fontSize(15).font('Helvetica-Bold').text(title, { align: 'left' });
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text(`Versão ${version.versionNumber}`);
    doc.moveDown(1);

    // Partes.
    doc.fillColor(BRAND_DARK).fontSize(12).font('Helvetica-Bold').text('Partes', { underline: true });
    doc.moveDown(0.4);
    if (parties.length === 0) {
      doc.fontSize(10).font('Helvetica').text('Nenhuma parte cadastrada até o momento da geração deste documento.');
    } else {
      parties.forEach((party) => {
        doc.fontSize(10).font('Helvetica-Bold').text(`${party.role}: `, { continued: true }).font('Helvetica').text(party.name);
        if (party.document) doc.fontSize(9).fillColor('#666666').text(`Documento: ${party.document}`).fillColor(BRAND_DARK);
        doc.moveDown(0.3);
      });
    }
    doc.moveDown(0.7);

    // Cláusulas — título em negrito, corpo justificado.
    doc.fillColor(BRAND_DARK).fontSize(12).font('Helvetica-Bold').text('Cláusulas', { underline: true });
    doc.moveDown(0.4);
    clauses.forEach((clause) => {
      doc.fontSize(11).font('Helvetica-Bold').text(clause.title);
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').text(clause.body, { align: 'justify' });
      doc.moveDown(0.6);
    });

    // Rodapé de integridade em todas as páginas — hash de conteúdo + id do contrato.
    // CUIDADO (bug real encontrado testando o PDF gerado): `bottom` fica DENTRO da margem
    // inferior da página (`margin: 50`, ver topo da função) de propósito, pra não colidir com
    // o conteúdo — mas o pdfkit, por padrão, considera escrever ABAIXO da margem como "não
    // cabe na página" e insere uma página nova automaticamente antes de desenhar, resultando
    // numa página extra em branco só com o rodapé (o rodapé da última página "vazava" pra uma
    // página seguinte fantasma). Zerar `page.margins.bottom` temporariamente, só durante este
    // desenho, evita esse auto-paginamento indevido sem afetar o fluxo normal do conteúdo.
    const pageRange = doc.bufferedPageRange();
    for (let i = 0; i < pageRange.count; i += 1) {
      doc.switchToPage(pageRange.start + i);
      const originalBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const bottom = doc.page.height - 40;
      doc.fontSize(7).fillColor('#999999').font('Helvetica').text(
        `Contrato ${contract.id} • Hash de integridade (SHA-256): ${version.contentHash || '(ausente)'} • Página ${i + 1}/${pageRange.count}`,
        50,
        bottom,
        { width: doc.page.width - 100, align: 'center', lineBreak: false }
      );
      doc.page.margins.bottom = originalBottomMargin;
    }

    doc.end();
  });

  const contractNumberForFile = String(contract.contractNumber || contract.id).replace(/[^a-zA-Z0-9-]/g, '_');
  const fileName = `contrato-${contractNumberForFile}.pdf`;

  // Sem persistência aqui de propósito (ver comentário no topo da função) — nada de File,
  // FileLink ou disco. O PDF é uma representação derivada e descartável; a fonte de verdade
  // auditável continua sendo ContractVersion (content + content_hash), que já é gravada com
  // sua própria trilha de auditoria em contractVersions.service.js#createContractVersion.
  return { buffer: pdfBuffer, fileName, contract, version };
}

module.exports = { generateContractPdf, parseRenderedContent };
