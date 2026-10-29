'use strict';

/**
 * Leitor da suspensão por anomalia (M9-D821 etapa 2b; dona do dado: M9-D824, `dlp_restricted_until`). Enquanto a M9-D824 não existe, o leitor padrão devolve
 * "sem suspensão". A M9-D824 troca o leitor chamando `setReader` com a mesma assinatura:
 *   reader(tenant, userId, transaction) -> Promise<Date|null>   (instante até quando o usuário está suspenso)
 */
const noSuspension = async () => null;
let current = noSuspension;

const setReader = (fn) => { current = fn; };
const resetReader = () => { current = noSuspension; };
const readSuspension = (tenant, userId, transaction) => current(tenant, userId, transaction);

module.exports = { setReader, resetReader, readSuspension };
