# Deploy do Marco 9 — ordem das migrations e da API

A API antiga (Marcos 3 a 8) tolera as migrations `20260101000650` a `20260101009963`. Os gatilhos de somente leitura do legado do Correspondente (`provider_accounts`, `integration_errors`, `webhook_inbox`) ficam na migration `20260101009964` (as três que vêm depois dela, da correção de 10 e 11/11/2026, não tocam o legado) e só podem ser aplicados quando a API do Marco 9 já estiver no ar (ela grava pelo registro de integração e define `app.integration_legacy_write='on'` quando precisa gravar no legado).

## Cofre de segredos: configurar ANTES de publicar esta versão

Desde a correção do e-mail de campanha (DI-D202-11 e verificação K=7, DI-M9E-5), a API de homologação ou produção **não sobe** sem um cofre de segredos que grave e leia de verdade. O link de descadastro de todo e-mail de marketing é assinado com a chave da empresa guardada nesse cofre. Sem ele, o e-mail não sai.

Variáveis de ambiente do serviço da API (Easypanel > serviço da API > Environment). Nenhum valor real vai para o repositório nem para este documento:

| Variável | Valor | Observação |
|---|---|---|
| `SECRET_STORE_DRIVER` | `file-mounted` | Alternativa: `http-vault`, com `SECRET_STORE_VAULT_URL` (HTTPS) e `SECRET_STORE_VAULT_TOKEN`. O modo `sandbox` em memória é recusado em homologação e produção. |
| `SECRET_STORE_DIR` | `/var/lib/nayara/cofre` | Pasta persistente fora de `/app`, com leitura e escrita para o uid 1001, que é o usuário do container. A imagem já cria essa pasta com dono 1001 e permissão 700. |
| `SECRET_STORE_MASTER_KEY` | saída de `openssl rand -hex 32` | São 32 bytes em hex (64 caracteres). Gere uma chave por ambiente e guarde-a fora do servidor, no cofre de senhas da empresa. **Nunca troque essa chave depois de gravar segredos**: com outra chave, tudo o que já foi gravado fica ilegível e o boot recusa subir. |
| `INTEGRATION_ENVIRONMENT` | `HOMOLOG` na homologação, `PRODUCTION` na produção | Já existe nos ambientes publicados. Confira o valor. |

Volume: em Easypanel > serviço da API > Mounts, monte um volume persistente em `/var/lib/nayara/cofre`. Sem volume persistente, as chaves somem a cada deploy e os links de descadastro já enviados deixam de valer.

O dono da pasta montada precisa ser o uid 1001:
- **Bind mount** (pasta do host): no host, rode `chown -R 1001:1001 <pasta>` e `chmod 700 <pasta>`.
- **Volume nomeado**: no host, rode `docker run --rm -v <nome-do-volume>:/cofre alpine sh -c 'chown -R 1001:1001 /cofre && chmod 700 /cofre'`.

Esse ajuste é necessário porque a imagem anterior não tem essa pasta, e o Docker então cria o ponto de montagem com dono root.

Conferência depois de configurar e reiniciar:
- O log do boot mostra `Cofre de segredos conferido no boot: grava e lê`.
- `GET /api/health` responde `secretStore.status = "ok"` e `secretStore.driver = "file-mounted"`. O campo nunca mostra caminho, chave ou valor.
- Se o cofre não funcionar, a porta não abre e o processo sai com código 1. O log mostra `Boot recusado: Cofre de segredos configurado mas inutilizável: ...` (código `INTEGRATION_SECRET_STORE_UNUSABLE`) e o motivo:
  - diretório sem escrita para o uid 1001;
  - chave mestra que não abre os segredos já gravados;
  - cofre externo inalcançável ou credencial recusada.
- Se faltar o cofre, a mensagem é `INTEGRATION_SECRET_STORE_NOT_CONFIGURED`, com as variáveis a definir.

## Ordem

0. Configurar o cofre de segredos **antes** de publicar esta versão:
   - (a) Criar o volume e acertar o dono (seção acima).
   - (b) Definir `SECRET_STORE_DRIVER`, `SECRET_STORE_DIR` e `SECRET_STORE_MASTER_KEY` e conferir `INTEGRATION_ENVIRONMENT`.
   - (c) Reiniciar a API ainda na versão que está no ar. Ela não exige o cofre, mas passa a usá-lo.
   - (d) Conferir que o cofre é lido. Mande `POST /api/v1/marketing/unsubscribe` com um token bem formado e falso:
     `{"token":"v1.<id da empresa>.<id de uma pessoa>.EMAIL.<64 zeros>"}`.
     A resposta precisa ser 404 `MKT_UNSUBSCRIBE_LINK_INVALID`, e não 503 `MKT_UNSUBSCRIBE_KEY_UNAVAILABLE`.

   Só então seguir para o passo 1. Se esta versão for publicada sem o cofre, ou com o cofre sem escrita, a API não sobe. O log diz o motivo, e dá para voltar à versão anterior enquanto o cofre é corrigido.
1. Backup novo imediatamente antes (`pg_dump -Fc`, com SHA-256), em `backups/` (ignorado pelo git).
2. Aplicar as migrations `20260101000650` a `20260101009963` (`npx sequelize-cli db:migrate --env migration --to 20260101009963-relatorio-saneamento-chaves-protegidas.js`). A API antiga continua funcionando.
3. Deploy da API e do Front do Marco 9 e conferir `/api/health` e `/api/version`.
4. Aplicar a `20260101009964-fecha-o-legado-com-gatilhos-somente-leitura.js` e as três da correção de 10 e 11/11/2026 (`20260101009965`, `20260101009966` e `20260101009970`, seção "Migrations depois da 9964") com um único `npx sequelize-cli db:migrate --env migration`. Todas são idempotentes.
5. Fumaça: criar e listar uma connection do registro, receber um webhook de financiamento sandbox, abrir o painel do Correspondente.
6. E-mail de campanha:
   - Conferir `secretStore.status = "ok"` em `/api/health`.
   - Recuperar, com o roteiro de `docs/runbooks/COFRE_DE_SEGREDOS.md` (seção 4), as entregas que ficaram FAILED por falha transitória antes desta versão, como as da campanha `cfc5c8e1` com `MKT_UNSUBSCRIBE_KEY_UNAVAILABLE`.

### Migration desta correção

A `20260101000757-marketing-campaign-delivery-retry.js` acrescenta os estados abertos da entrega de campanha (RETRY, UNKNOWN, CANCELLED), os contadores de tentativa, a hora da próxima tentativa e o gatilho que mantém as linhas finais imutáveis. Ela também concede UPDATE ao `nayara_runtime`.
- É aditiva e a API antiga a tolera: só grava SENT, BLOCKED e FAILED, e as colunas novas têm padrão.
- Por isso entra no passo 2, junto com as demais. Ela tem número menor que as já aplicadas, mas o `db:migrate` aplica toda migration pendente.
- A `down` recusa se houver entrega em RETRY, UNKNOWN ou CANCELLED, porque não apaga dados.

A `20260101000762-marketing-automation-action-retry.js` (DI-M9F-1) acrescenta o estado RETRY à lista de estados aceitos do resultado por ação das runs de automação (função `marketing.actions_result_valid`), para a ação SEND_MESSAGE com falha transitória esperar a nova tentativa em vez de ficar OK com a mensagem presa na fila.
- Só troca a função (`CREATE OR REPLACE`), e a lista só cresce: toda linha existente continua válida, e a API antiga não grava RETRY.
- Entra no passo 2, junto com as demais (número menor que as já aplicadas; o `db:migrate` aplica toda migration pendente).
- A `down` recusa se alguma run tiver ação em RETRY, porque não apaga nem reescreve dados.

### Migrations depois da 9964

Nenhuma delas toca os gatilhos de somente leitura nem as três tabelas do legado (o teste `m9d200.legado-somente-leitura` confere). A API antiga tolera as três.
- `20260101009965-isola-pessoas-por-empresa-nas-politicas-rls.js`: troca a política de gravação de `people.persons` (FOR ALL só por grupo) por políticas de INSERT, UPDATE e DELETE por empresa, como a de leitura. Corrige o vazamento de Pessoas entre empresas do mesmo grupo (ponto 5).
- `20260101009966-pessoas-filhos-so-com-pessoa-da-mesma-empresa.js`: chaves compostas pessoa e empresa nos cadastros filhos (descrita abaixo, em "Ponto 5 do aceite").
- `20260101009970-create-analytics-metric-snapshot-confirmations.js`: tabela `analytics.metric_snapshot_confirmations` (DI-BI-2), com RLS FORCE, a última confirmação de cada snapshot pela fonte; o snapshot continua imutável.

## Plano de reversão

- Antes do passo 4: `npx sequelize-cli db:migrate:undo:all --to 20260101000648-dimob-gatilho-congelamento-estrito.js --env migration` (as `down` das migrations aditivas derrubam apenas objetos novos). Se alguma `down` falhar, parar a API e restaurar o backup (`pg_restore --clean --if-exists --no-owner`).
- Depois do passo 4, se for preciso voltar à API antiga: desfazer até a 9963 (`npx sequelize-cli db:migrate:undo:all --to 20260101009964-fecha-o-legado-com-gatilhos-somente-leitura.js --env migration`), o que desfaz, nesta ordem, a 9970, a 9966, a 9965 e a 9964 (esta remove os três gatilhos), e então reimplantar a API antiga.
- A `009962` apaga linhas condicionais (permissão `integration:platform` e chaves `integration.*` gravadas por quem não é operador); a `down` não as restaura, só o backup.

## Observações conhecidas (documentadas, não corrigidas)

- As migrations `858` e `879` convertem o vocabulário de `classification` para LOW/MEDIUM/HIGH/RESTRICTED: `POST /properties/:id/media` com `PUBLIC` ou `INTERNAL` passa de 201 para 500 na API antiga. O Front não envia esse campo e os dados de homologação já estão no vocabulário aceito.
- A `009962` apaga só linhas da permissão `integration:platform` e de chaves `integration.*` gravadas por não operador; o `down` não restaura (só o backup).
- A D612 tenta criar o role `nayara_analytics_reader`; sem CREATEROLE ela trata o erro e segue (a API fica só com a transação READ ONLY).

## Ponto 5 do aceite (branch m9fix/ponto5-m9)

- Migration `20260101009966-pessoas-filhos-so-com-pessoa-da-mesma-empresa.js` (ISO-8, DI-M9R-1) entra no passo 4 com as demais (`npx sequelize-cli db:migrate --env migration`). Antes de criar as chaves compostas (contato, endereço, documento, papel e consentimento só com pessoa da MESMA empresa), ela imprime por tabela quantas linhas apontam para pessoa de outra empresa. Com zero (o esperado: a leitura de 10/11 achou zero nas 44 colunas `*person_id*`), cria as chaves. Com alguma, PARA sem alterar nada e lista as contagens: o destino desses dados é decisão de negócio; corrija e rode de novo. A API antiga já grava os filhos com a empresa da pessoa, então a ordem com o deploy da API não importa. Reversão: `npx sequelize-cli db:migrate:undo --env migration --name 20260101009966-pessoas-filhos-so-com-pessoa-da-mesma-empresa.js` (remove só as seis constraints).
- O bloqueio de envio da campanha passa a gravar `marketing.message.blocked` por destinatário (DI-M9R-2); sem migration.
- Depois do deploy, o reteste do ponto 5 é `scripts/homo/retestePonto5Marco9.js` (comando completo em `Maturacao/fechamento-m3-m6/m9-ponto5.md`). Rodar fora do horário de silêncio do Marketing (padrão 21:00 a 08:00) e com o cofre de segredos configurado, senão o e-mail do contato com opt-in (o controle positivo) não sai.
