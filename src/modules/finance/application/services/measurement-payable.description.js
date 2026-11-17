'use strict';

const { BUSINESS_TIMEZONE } = require('../../../../utils/businessDate');

/**
 * Descrição LEGÍVEL da conta a pagar gerada pela medição aprovada (measurement-payable.consumer.js). Padrão do projeto: nenhuma
 * chave técnica na tela; antes a descrição terminava com "(medição <uuid>)", que aparecia em Financeiro > Aprovações.
 * A referência é a que a pessoa reconhece: obra, etapa, percentual medido e o dia da aprovação (fuso de São Paulo). O valor já é o
 * campo próprio da conta. O vínculo com a medição continua pelos campos próprios: idempotencyKey `measurement.payable:<medição>` e
 * sourceEventId (id do evento measurement.approved); nada depende deste texto.
 * Evento antigo sem o nome da obra ou da etapa: a parte que falta sai do texto (nunca o id no lugar do nome).
 * A coluna description tem 255 caracteres: os nomes são encurtados (com reticências) para o texto inteiro caber.
 */
const MAX_DESCRIPTION = 255;
const MAX_NAME = 90;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function readableName(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text || UUID_RE.test(text)) return null;
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1).trimEnd()}…` : text;
}

function percentText(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% medido`;
}

function dayText(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `aprovada em ${new Intl.DateTimeFormat('pt-BR', { timeZone: BUSINESS_TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)}`;
}

/** payload do evento measurement.approved; approvedAt = instante da aprovação (o mesmo que conta o vencimento). */
function measurementPayableDescription(payload = {}, approvedAt = null) {
  const project = readableName(payload.projectName);
  const stage = readableName(payload.stageName);
  const parts = [project && `obra "${project}"`, stage && `etapa "${stage}"`, percentText(payload.measuredPct), dayText(approvedAt)].filter(Boolean);
  const text = parts.length ? `Medição aprovada — ${parts.join(', ')}` : 'Medição aprovada';
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

module.exports = { measurementPayableDescription, MAX_DESCRIPTION };
