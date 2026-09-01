# Divisão de roteamento de DM: imobiliariaBot vs. canal de lead comercial do SaaS — Design

> Branch: `local/imobiliaria-dm-bot` (experimental, nunca faz merge em `main` — ver CLAUDE.md do projeto).

## Contexto

Hoje `src/lib/imobiliariaBot.js` é o único handler de DM: toda DM é checada contra
um Postgres externo (`fn_checar_autorizacao`) e, se autorizada, encaminhada para um
único webhook do CRM (captação de corretor/cliente da imobiliária). DMs não
autorizadas são descartadas silenciosamente.

O fluxo de grupo PIX (`src/lib/inboundMedia.js` + `Courier.processIncomingMessage`)
é um assunto separado e não relacionado — só mídia, só grupo, sem auth — e deve
continuar intocado por este trabalho.

## Objetivo

Adicionar um segundo canal de DM, totalmente independente: o funil de
vendas/captação de lead do próprio produto wa-courier (SaaS). Toda DM não
reclamada pelo `imobiliariaBot` (não autorizada, não resolvível, ou feature
desabilitada) cai para este novo canal, que encaminha incondicionalmente (sem
autorização) para seu próprio webhook. Este canal **não tem nenhuma relação**
com os dados/webhook da imobiliária — é um produto distinto, com dados distintos.

## Fora de escopo

- Nenhuma mudança no fluxo de grupo PIX.
- Nenhuma mudança na lógica de autorização via Postgres do `imobiliariaBot` nem no
  contrato do seu webhook, além de fazer seu ponto de entrada informar se reclamou
  a mensagem ou não.
- Nenhuma lógica de negócio do funil de vendas dentro do wa-courier (isso é
  trabalho do n8n/CRM).
- Sem rate limiting (adiado explicitamente — só teste com um único usuário por
  enquanto).
- Sem novos endpoints HTTP de admin (os dois canais de DM são só env var, mesmo
  padrão que o `imobiliariaBot` já usa — sem lista dinâmica de JID pra gerenciar,
  já que os dois são catchall: um travado por Postgres, outro aberto).
- Sem testes automatizados para este módulo (decisão já tomada do usuário para
  esta branch).

## Design

### Mudanças em arquivos

- `src/lib/inboundMedia.js`, `Courier.processIncomingMessage` — **intocados**.
- `src/lib/inboundContent.js` (**novo**) — parsing em nível de protocolo,
  compartilhado pelos dois canais de DM, sem lógica de negócio:
  - `extractContent(message)` → `{ kind: 'text', text }` ou
    `{ kind: 'media', type, ptt, mimetype, fileName, caption, declaredSize }`
    (movido tal e qual de `imobiliariaBot.js`, cobrindo texto/áudio/imagem/documento).
  - `isDmJid(jid)` (movido de `imobiliariaBot.js`).
- `src/lib/imobiliariaBot.js` — mesmo comportamento, duas mudanças:
  1. Passa a importar `extractContent`/`isDmJid` de `inboundContent.js` em vez de
     defini-los localmente.
  2. `handleIncomingDm(courier, message)` agora **retorna um boolean**: `true` se
     a mensagem foi autorizada e o encaminhamento foi tentado (independente do
     resultado HTTP do próprio webhook), `false` para todo caminho de saída
     antecipada (não é DM, `fromMe`, conteúdo não suportado, telefone não
     resolvido, denylisted, não autorizado).
  3. Nova checagem de denylist, logo após a resolução do telefone e antes da
     query no Postgres: se o telefone resolvido está em `WAC_IMOBILIARIA_DENYLIST`,
     retorna `false` imediatamente (sem chamar o Postgres). Permite excluir um
     número específico deste fluxo permanentemente, independente do que o
     Postgres diga — usado pro número de teste do próprio usuário, garantindo que
     ele sempre caia pro canal de vendas.
- `src/lib/salesLeadBot.js` (**novo**) — espelha o formato de `imobiliariaBot.js`,
  menos Postgres/auth/cache:
  - `isEnabled()` → `Boolean(webhookUrl)`, `webhookUrl` vindo de
    `WAC_SALES_LEAD_WEBHOOK_URL` (não definida hoje — o código precisa lidar com
    isso graciosamente, igual `inboundMediaWebhookUrl` já faz: loga e pula, nunca
    lança exceção).
  - `handleIncomingDm(courier, message)` — nunca lança exceção. Extrai o conteúdo
    via `inboundContent.extractContent`; se não suportado, retorna. Encaminha
    incondicionalmente (`authMode: none`) — texto via POST JSON, mídia via
    multipart, ambos usando os helpers já existentes `signPayload`/
    `postJsonWithRetry` em `./webhook.js` (mesmo padrão de
    `X-Webhook-Signature` dos outros dois webhooks). `from` é o `remoteJid` bruto —
    sem normalização de telefone PN/LID, já que não há lookup no Postgres por
    telefone aqui.
- `src/lib/courier.js` (`handleIncomingMessages`) — substitui o branch único
  `dmBotEnabled` por uma cadeia de "reclamação" (claim chain) para DMs:

  ```js
  const dmBotEnabled = imobiliariaBot.isEnabled()
  const salesBotEnabled = salesLeadBot.isEnabled()
  if (allowedGroups.size === 0 && !dmBotEnabled && !salesBotEnabled) return

  for (const message of messages || []) {
    try {
      const remoteJid = message?.key?.remoteJid
      if (isDmJid(remoteJid)) {
        let claimed = false
        if (dmBotEnabled) claimed = await imobiliariaBot.handleIncomingDm(this, message)
        if (!claimed && salesBotEnabled) await salesLeadBot.handleIncomingDm(this, message)
      } else {
        await this.processIncomingMessage(message, allowedGroups)
      }
    } catch (error) {
      logger.error({ error }, 'Failed to process incoming message')
    }
  }
  ```

  `isDmJid` também importado de `inboundContent.js` aqui.

### Payload do webhook — canal de lead comercial (contrato novo, sem restrição de compatibilidade)

Texto (corpo JSON, assinado do mesmo jeito que o webhook de status):

```json
{ "event": "sales_lead.message", "kind": "text", "from": "...", "messageId": "...", "ts": "...", "text": "..." }
```

Mídia (formulário multipart, assinatura sobre os campos de metadado, mesma
convenção de `forwardInboundMedia`/`imobiliariaBot.forwardMedia`):

- `event=sales_lead.message`, `kind=media`, `from`, `messageId`, `ts`, `type`,
  `ptt`, `fileName`, `mimetype`, `caption`, `file` (o blob).

Sem campo `authorized`/`tipo` — este canal não tem conceito de autorização.

### Formato da denylist

`WAC_IMOBILIARIA_DENYLIST` — números de telefone separados por vírgula, no mesmo
formato normalizado que `resolvePhone` já produz (DDI + DDD + número, só dígitos,
ex.: `5511999999999` — placeholder, nunca um número real neste repo). Valores
reais moram só no env local/produção de quem faz o deploy, nunca commitados.

### Env vars introduzidas

- `WAC_SALES_LEAD_WEBHOOK_URL` — destino do webhook do canal de lead comercial.
  Ainda não definida; o código precisa se comportar corretamente com ela vazia
  (`isEnabled()` falso, canal inerte).
- `WAC_IMOBILIARIA_DENYLIST` — números de telefone excluídos do fluxo
  `imobiliariaBot` independente do Postgres.

## Autorrevisão

1. **Varredura de placeholder** — nenhum TBD/TODO restante; `WAC_SALES_LEAD_WEBHOOK_URL`
   estar vazia é uma condição inicial declarada e intencional, não um placeholder.
2. **Consistência interna** — a cadeia de reclamação em `courier.js` bate com o
   contrato de retorno boolean definido para `imobiliariaBot.handleIncomingDm`;
   `salesLeadBot` não precisa de um retorno consumido por ninguém (é o último da
   cadeia), mas retorna `undefined` implicitamente, igual `imobiliariaBot` fazia
   antes desta mudança — inofensivo, ninguém lê esse retorno.
3. **Checagem de escopo** — um único plano de implementação, três arquivos
   novos/alterados mais um ajuste de orquestração em `courier.js`. Não decomposto
   além disso.
4. **Checagem de ambiguidade** — "reclamada" (claimed) é definida com precisão
   (autorizada E tentativa de processamento iniciada, independente do resultado
   HTTP do webhook) pra evitar a leitura ambígua "reclamada = webhook teve
   sucesso" (que erroneamente re-rotearia a mensagem de um corretor autorizado
   pro canal de vendas em caso de falha transitória de rede).
