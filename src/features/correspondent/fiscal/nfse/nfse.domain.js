'use strict';

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** Estado da nota no emissor (PROCESSING, AUTHORIZED, REJECTED, CANCELED) -> estado do pedido de NFS-e do Fiscal (SUBMITTED, AUTHORIZED, REJECTED, CANCELED). */
const INVOICE_STATUS = Object.freeze({ PROCESSING: 'SUBMITTED', AUTHORIZED: 'AUTHORIZED', REJECTED: 'REJECTED', CANCELED: 'CANCELED' });
const invoiceStatusOf = (providerStatus) => INVOICE_STATUS[String(providerStatus || '').toUpperCase()] || null;

/**
 * Objeto de domínio da emissão (M9-D241 3.1): o que o mapper `fiscal.issueNfse` aceita. O RPS é a chave natural; o valor vai como texto decimal (a integração só transporta o valor
 * que o Fiscal calculou); o tomador e o serviço levam só o necessário. Nenhuma entidade ou DTO.
 */
function issueDomainObject({ invoice, rps, amount, description, fiscal, takerTaxId, takerName }) {
  return clean({
    rps: { series: rps.series, number: String(rps.number) }, amount: Number(amount).toFixed(2), invoiceRef: invoice.id,
    taker: Object.keys(clean({ name: takerName, document: takerTaxId })).length ? clean({ name: takerName, document: takerTaxId }) : undefined,
    service: clean({ code: fiscal.nfseServiceCode || undefined, description }), taxes: fiscal.nfseIssRatePct ? { issRatePct: String(fiscal.nfseIssRatePct) } : undefined,
  });
}

/** Objeto da consulta de status: o identificador da nota, o RPS e o que o emissor de laboratório precisa para montar os arquivos. */
const statusDomainObject = ({ invoice, rps }) => clean({ externalResourceId: invoice.externalId, rps: rps ? { series: rps.series, number: String(rps.number) } : undefined, amount: Number(invoice.amount).toFixed(2), serviceDescription: invoice.description });

/** Objeto do cancelamento: o identificador da nota, o RPS e o motivo. */
const cancelDomainObject = ({ invoice, rps, reason }) => clean({ externalResourceId: invoice.externalId, rps: rps ? { series: rps.series, number: String(rps.number) } : undefined, reason });

module.exports = { INVOICE_STATUS, invoiceStatusOf, issueDomainObject, statusDomainObject, cancelDomainObject };
