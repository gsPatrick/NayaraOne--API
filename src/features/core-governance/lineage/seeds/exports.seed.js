'use strict';

// M9-D822 §3.2 item 5 — cada entrada do catálogo de exportações (POST /exports) registra o nó EXPORT de lineage no mesmo commit: campos de origem lidos -> campo de domínio
// -> evento da auditoria da exportação -> tabela de onde o arquivo é lido -> exportação. A DIMOB já tem o nó (`dimob.file`, M9-D810) e fica de fora. Derivado do catálogo: exportação
// nova sem `lineage` nele reprova o teste m9d822.inventario, e o portão da M9-D811 exige o arquivo do registro em dia.
const { fieldNodes, edge } = require('../kit/paths');
const { NODE } = require('../lineage.constants');
const { ON_DEMAND } = require('../../dlp/exports/exports.catalog');

// O evento é o registro de auditoria que o gerador grava quando o arquivo fica pronto (dlp.export.generated, export.audit.js), o mesmo para todas as exportações.
const EVENT = { ownerDomain: 'TECNOLOGIA', area: 'OTHER', criticality: 'NORMAL', nodeType: NODE.EVENT, code: 'dlp.export.generated', description: 'Registro de auditoria dlp.export.generated: o arquivo da exportação ficou pronto (quem pediu, formato, linhas e hash).' };

function build() {
  const nodes = [EVENT]; const edges = [];
  for (const entry of ON_DEMAND.filter((item) => !item.lineage.existingExportCode)) {
    const { area, ownerDomain, criticality, description, readModel, columns } = entry.lineage;
    const base = { ownerDomain, area, criticality };
    const READ_MODEL = { ...base, nodeType: NODE.READ_MODEL, code: readModel.code, description: readModel.description };
    const EXPORT = { ...base, nodeType: NODE.EXPORT, code: `export.${entry.code}`, description };
    nodes.push(READ_MODEL, EXPORT);
    edges.push(edge(EVENT, READ_MODEL, 'a exportação lê a tabela'), edge(READ_MODEL, EXPORT, 'o arquivo é montado das linhas da tabela'));
    for (const column of columns) {
      const { source, domain } = fieldNodes(column);
      nodes.push(source, domain); edges.push(edge(source, domain, 'coluna lida pelo atributo do modelo'), edge(domain, EVENT, 'entra no arquivo exportado'));
    }
  }
  return { nodes, edges };
}

module.exports = { code: 'M9-D822-exports', build };
