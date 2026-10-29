'use strict';

// M9-D810 §3.3 — área DIMOB (dimob.service.js): o arquivo anual da DIMOB. Origem = o que o conjunto de dados lê (aluguéis liquidados, contratos e partes,
// pessoas, imóvel e comissões de correspondente); evento = o registro de auditoria da geração do lote (a DIMOB não publica evento de domínio);
// read model = correspondent.dimob_records (o conjunto de dados gravado, que o arquivo apenas lê); exportação = o arquivo de download.
const { fieldNodes, edge } = require('../kit/paths');
const { NODE, AREA } = require('../lineage.constants');

const COLUMNS = [
  'finance.financial_entries.amount', 'finance.financial_entries.settled_at', 'finance.financial_entries.status',
  'legal.contracts.contract_number', 'legal.contracts.contract_type', 'legal.contracts.total_value', 'legal.contract_parties.party_role', 'legal.contract_parties.person_id',
  'people.persons.legal_name', 'people.persons.tax_id_normalized', 'real_estate.properties.internal_code',
  'correspondent.commission_entitlements.amount', 'correspondent.commission_entitlements.status', 'correspondent.commission_entitlements.received_at',
];
const base = { ownerDomain: 'FISCAL', area: AREA.DIMOB, criticality: 'CRITICAL' };
const EVENT = { ...base, nodeType: NODE.EVENT, code: 'correspondent.dimob.batch_generated', description: 'Registro de auditoria da geração do lote anual da DIMOB (nova versão do lote, com o hash do conjunto de dados).' };
const READ_MODEL = { ...base, nodeType: NODE.READ_MODEL, code: 'correspondent.dimob_records', description: 'Registros do lote da DIMOB (correspondent.dimob_records): o conjunto de dados já validado, de onde o arquivo é lido.' };
const EXPORT = { ...base, nodeType: NODE.EXPORT, code: 'dimob.file', description: 'Arquivo anual da DIMOB (download do lote fechado, com layout versionado por ano).' };

function build() {
  const nodes = [EVENT, READ_MODEL, EXPORT]; const edges = [edge(EVENT, READ_MODEL, 'o lote grava os registros'), edge(READ_MODEL, EXPORT, 'o arquivo é montado dos registros do lote')];
  for (const column of COLUMNS) {
    const { source, domain } = fieldNodes(column);
    // a DIMOB tem área própria: o campo continua com a definição do kit (igual em qualquer semente); só o caminho até a exportação é dela.
    nodes.push(source, domain); edges.push(edge(source, domain, 'coluna lida pelo atributo do modelo'), edge(domain, EVENT, 'entra no conjunto de dados do lote'));
  }
  return { nodes, edges };
}

module.exports = { code: 'M9-D810-dimob', build };
