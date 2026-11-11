# Runbook: cofre de segredos e e-mail de campanha

Este runbook trata do cofre de segredos da API (M9-D202) e do e-mail de campanha, que depende dele.
- Configuração no deploy: `docs/DEPLOY_MARCO_9.md`, seção "Cofre de segredos".
- Decisões: DI-D202-11 e DI-M9E-1 a DI-M9E-6, em `Maturacao/demandas/decisoes-de-implementacao.md`.

## 1. O que é

O cofre guarda, cifrados, os segredos da API:
- a chave da empresa que assina o link de descadastro de todo e-mail de marketing;
- o segredo do person_hash dos links rastreados;
- as credenciais das integrações.

Ele é configurado por variável de ambiente do processo:
- `SECRET_STORE_DRIVER`, `SECRET_STORE_DIR` e `SECRET_STORE_MASTER_KEY` no driver `file-mounted`;
- ou `SECRET_STORE_VAULT_URL` e `SECRET_STORE_VAULT_TOKEN` no driver `http-vault`.

Nenhuma tela ou parâmetro da API configura o cofre.

## 2. Como saber se está funcionando

- **`GET /api/health`**, campo `secretStore`:
  - `status`: `ok`, `unusable`, `not_configured` ou `invalid`;
  - também traz `driver`, `checkedAt`, `latencyMs` e o `code` quando falha;
  - a prova é refeita no máximo a cada 30 s e grava e lê um canário no driver `file-mounted`;
  - nunca mostra caminho, valor, chave ou endereço.
- **Boot em homologação ou produção**: a porta só abre depois da mesma prova.
  - Se der certo, o log mostra `Cofre de segredos conferido no boot: grava e lê`.
  - Se falhar, o processo sai com código 1 e o log mostra `Boot recusado: ...` com um destes códigos:

| Código | Causa | O que fazer |
|---|---|---|
| `INTEGRATION_SECRET_STORE_NOT_CONFIGURED` | Falta `SECRET_STORE_DRIVER`. | Definir as variáveis (seção do deploy). |
| `INTEGRATION_SECRET_STORE_CONFIG` | Chave mestra ausente ou fora de 32 bytes, pasta dentro de `/app`, driver inválido, vault sem HTTPS ou cofre em memória. | Corrigir a variável indicada na mensagem. |
| `INTEGRATION_SECRET_STORE_UNUSABLE` "não foi possível acessar o diretório" ou "gravar e ler o canário" | A pasta não existe ou não tem leitura e escrita para o uid 1001. | `chown -R 1001:1001` e `chmod 700` na pasta do volume. Conferir que o volume está montado em `SECRET_STORE_DIR`. |
| `INTEGRATION_SECRET_STORE_UNUSABLE` "abrir os segredos já gravados" | `SECRET_STORE_MASTER_KEY` não é a mesma de quando os segredos foram gravados. | Restaurar a chave mestra original, guardada no cofre de senhas da empresa. Nunca gerar outra. |
| `INTEGRATION_SECRET_STORE_UNUSABLE` "cofre externo" | O `http-vault` está fora do ar, a credencial foi recusada ou o prazo estourou. | Conferir `SECRET_STORE_VAULT_URL`, `SECRET_STORE_VAULT_TOKEN` e a rede. |

## 3. O que acontece com o e-mail quando o cofre ou o provedor falham

A campanha não perde o e-mail por uma falha passageira (verificação K=7, item 5).

| Situação | Estado da entrega | Mensagem no CRM | O que acontece depois |
|---|---|---|---|
| Cofre fora por um instante (`MKT_UNSUBSCRIBE_KEY_UNAVAILABLE`) | `RETRY` | nenhuma (nada saiu) | Nova tentativa com backoff. Quando o cofre volta, o e-mail sai. |
| Provedor 429 ou 5xx | `RETRY` | `QUEUED` | Nova tentativa com backoff e jitter, respeitando o Retry-After. O 429 não gasta tentativa enquanto os adiamentos seguidos ficam abaixo do limite. |
| Timeout ou resposta incerta | `UNKNOWN` | `UNKNOWN` | Antes de qualquer reenvio, consulta o provedor pela chave de idempotência. Se achar, marca SENT e não reenvia. Se o provedor confirmar que não recebeu, reenvia com a mesma chave. Se a consulta não for conclusiva, espera e tenta de novo até o limite. |
| Tentativas esgotadas | `FAILED MKT_DELIVERY_RETRIES_EXHAUSTED` | `FAILED` | Vai para a fila morta. Só o reprocessamento (seção 4) reabre. |
| Consultas do UNKNOWN esgotadas | `FAILED MKT_DELIVERY_UNKNOWN_EXHAUSTED` | continua `UNKNOWN` (não se finge falha) | Reprocessar volta a reconciliar antes de reenviar. |
| Opt-out ou supressão entre tentativas | `BLOCKED` | `CANCELLED` | Nada sai. |
| Campanha encerrada com entrega aberta | `CANCELLED`. O UNKNOWN é só reconciliado e nunca reenviado. | `CANCELLED` | Nada sai. |
| Recusa definitiva: endereço inválido, sem consentimento, conteúdo ou credencial recusados | `BLOCKED` ou `FAILED` | conforme o canal | Não há nova tentativa nem reprocessamento. |

Parâmetros: são os mesmos da nova tentativa por classe do bloco de Integrações, em Configurações > Integrações > Envio.
- Falha transitória: `integration.retry.max_attempts`, `base_delay_ms`, `factor`, `cap_delay_ms`, `jitter_pct`, `rate_limit_max_wait_s` e `rate_limit_max_deferrals`.
- Resultado incerto: `integration.unknown.max_reconcile_attempts` e `reconcile_intervals_s`.

O `GET /api/v1/marketing/campaigns/:id` mostra o resumo `deliveries`:
- a contagem por status e os motivos de cada status;
- quantas entregas estão abertas e a próxima tentativa;
- quantas o administrador pode reprocessar.

## 4. Recuperar entregas que ficaram FAILED por falha transitória

Antes desta correção, toda falha transitória virava FAILED definitivo. O caso conhecido é a campanha `cfc5c8e1-784c-4b1f-abc9-60411dbf67f3` da homologação, com o contato com consentimento em FAILED `MKT_UNSUBSCRIBE_KEY_UNAVAILABLE`.

O caminho de recuperação é a ação do administrador `POST /api/v1/marketing/campaigns/:id/deliveries/reprocess`, com o corpo `{ "reason": "..." }`.
- **Permissão**: `marketing:campaign:manage`.
- **Motivo**: obrigatório, com no mínimo 10 caracteres.
- **Campanha**: precisa estar em andamento (RUNNING e antes do fim). Encerrada responde 409.
- **O que volta para a fila**: só FAILED com motivo transitório e o BLOCKED `CANSEND_ERROR`. Recusa definitiva nunca volta.
- **Auditoria**:
  - `marketing.campaign.deliveries.reprocess` na campanha, com antes e depois;
  - `marketing.campaign.delivery.reprocessed` em cada entrega;
  - `marketing.campaign.step.reopened` no step que já tinha fechado.
- **Envio**: nada é enviado na chamada. O job de campanhas processa a entrega no ciclo seguinte, a cada minuto, com o canSend na hora: quem pediu opt-out depois não recebe. A chave de idempotência é a mesma, então o envio nunca duplica.

Passo a passo na homologação, depois do deploy desta versão e com `secretStore.status = "ok"`. Rode na pasta da API.

1. Consulta, sem alterar nada:
   ```
   HOMO_API_BASE=https://<api-da-homologacao>/api/v1 HOMO_ADMIN_EMAIL=<admin> HOMO_ADMIN_PASSWORD=<senha> \
   CAMPANHA_ID=cfc5c8e1-784c-4b1f-abc9-60411dbf67f3 node scripts/reprocessarEntregasCampanha.js
   ```
   Confira `reprocessáveis` (o esperado é 1) e o status da campanha. Se a campanha estiver ENDED, a recuperação não é possível, porque o livro não deixa a campanha encerrada continuar. Nesse caso, crie uma campanha nova para os mesmos contatos.
2. Reprocessar:
   ```
   ... REPROCESSAR=sim MOTIVO="Cofre configurado; reenvio das entregas que falharam sem cofre" ESPERAR_S=90 node scripts/reprocessarEntregasCampanha.js
   ```
   Depois da espera, o resumo deve mostrar a entrega como `SENT`. Se ela ainda aparecer como `RETRY`, a próxima tentativa já está agendada: rode a consulta de novo.
3. Conferir a auditoria `marketing.campaign.deliveries.reprocess` em Auditoria. Ela registra o autor, o motivo e a lista das entregas com o status anterior.

## 5. Chave mestra

- Gere a chave com `openssl rand -hex 32`, uma por ambiente.
- Guarde-a fora do servidor, no cofre de senhas da empresa. Nunca a cole em chat, ticket, log ou repositório.
- Não troque a chave depois de gravar segredos. Os arquivos ficam ilegíveis com outra chave, e o boot recusa subir com a mensagem "abrir os segredos já gravados".
- Faça backup do volume do cofre junto com o backup do banco. Sem o volume, a chave de descadastro de cada empresa se perde, e os links de descadastro de e-mails já enviados deixam de valer.
