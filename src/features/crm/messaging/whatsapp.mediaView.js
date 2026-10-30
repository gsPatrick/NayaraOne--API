'use strict';

const { FileQuarantine } = require('../../../models');

const ESTADOS = Object.freeze({
  QUARANTINED: { state: 'PENDING', display: 'Mídia em verificação de segurança.' },
  CLEAN: { state: 'RELEASED', display: 'Mídia liberada.' },
});
const BLOQUEADA = Object.freeze({ state: 'BLOCKED', display: 'Mídia bloqueada.' });

/**
 * Como a mídia recebida aparece na interação (M9-D230 3.3): em verificação, liberada (com o arquivo promovido) ou "Mídia bloqueada." (infectada, tipo ou tamanho recusado, vencida). Nada além de
 * liberada mostra o conteúdo. Acrescenta `mediaState`, `mediaDisplay` e `mediaFileId` às mensagens que têm mídia em quarentena; as demais saem intactas. Devolve a mesma lista.
 */
async function describeMedia(messages, transaction) {
  const lista = Array.isArray(messages) ? messages : [messages];
  const ids = [...new Set(lista.map((m) => m.mediaQuarantineId).filter(Boolean))];
  lista.filter((m) => !m.mediaQuarantineId && m.getDataValue('mediaState') === 'BLOCKED').forEach((m) => m.setDataValue('mediaDisplay', BLOQUEADA.display));
  if (ids.length === 0) return messages;
  const linhas = await FileQuarantine.findAll({ where: { id: ids }, transaction });
  const porId = new Map(linhas.map((l) => [l.id, l]));
  lista.forEach((m) => {
    if (!m.mediaQuarantineId) return;
    const q = porId.get(m.mediaQuarantineId);
    const estado = (q && ESTADOS[q.status]) || BLOQUEADA;
    m.setDataValue('mediaState', estado.state);
    m.setDataValue('mediaDisplay', estado.display);
    m.setDataValue('mediaFileId', estado.state === 'RELEASED' ? q.promotedFileId : null);
  });
  return messages;
}

module.exports = { describeMedia };
