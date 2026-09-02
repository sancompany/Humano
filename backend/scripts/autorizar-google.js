/**
 * SAN & CO. — backend/scripts/autorizar-google.js
 * Roda-se UMA VEZ, manualmente, para autorizar o app a acessar Drive,
 * Gmail e Agenda em seu nome. Depois disso, o refresh_token gerado aqui
 * vai pro .env e o backend nunca mais precisa deste script — a renovação
 * é automática (ver o comentário em googleAuth.js).
 *
 * COMO RODAR (na pasta backend/, com o .env já com GOOGLE_CLIENT_ID e
 * GOOGLE_CLIENT_SECRET preenchidos — sem eles, nem chega a começar):
 *
 *   npm run autorizar-google
 *
 * O que acontece:
 *   1. Este script sobe um servidor local, só pra esta autorização
 *      (porta 8085 — separada da porta 3000 do backend principal, pra
 *      não brigar se os dois estiverem rodando ao mesmo tempo).
 *   2. Imprime um link no terminal. Copie e cole no navegador.
 *   3. Você faz login com a conta Google que quer que o SAN & CO. use,
 *      e clica em "Permitir" na tela de consentimento.
 *   4. O Google te redireciona de volta pra este servidor local, que
 *      captura o código de autorização e troca ele pelo refresh_token.
 *   5. O script imprime o refresh_token e desliga sozinho.
 *   6. Cole esse valor em GOOGLE_REFRESH_TOKEN no .env. Pronto — não
 *      precisa rodar isto de novo, a menos que troque de conta Google ou
 *      adicione um escopo novo no futuro.
 */

import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { criarClienteOAuth, ESCOPOS } from '../services/googleAuth.js';

const PORTA_TEMPORARIA = 8085;

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error(
    '\n[autorizar-google] Faltam GOOGLE_CLIENT_ID e/ou GOOGLE_CLIENT_SECRET no .env.\n'
    + 'Pegue os dois no Google Cloud Console (veja o passo a passo que o Claude te deu)\n'
    + 'antes de rodar este script.\n'
  );
  process.exit(1);
}

const client = criarClienteOAuth();

const urlConsentimento = client.generateAuthUrl({
  access_type: 'offline',   // sem isso, o Google NÃO devolve refresh_token
  prompt: 'consent',        // força a tela de consentimento mesmo se já autorizou antes —
                             // garante que um refresh_token novo seja emitido desta vez
  scope: ESCOPOS
});

console.log('\n[autorizar-google] Abra este link no navegador e faça login com a conta');
console.log('que o SAN & CO. deve usar (Drive, Gmail e Agenda dessa conta):\n');
console.log(urlConsentimento);
console.log('\nEsperando você autorizar...\n');

const servidor = http.createServer(async (requisicao, resposta) => {
  const url = new URL(requisicao.url, `http://localhost:${PORTA_TEMPORARIA}`);

  if (url.pathname !== '/oauth2callback') {
    resposta.writeHead(404);
    return resposta.end();
  }

  const codigo = url.searchParams.get('code');
  const erro = url.searchParams.get('error');

  if (erro) {
    resposta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    resposta.end('<h2>Autorização cancelada. Pode fechar esta aba e tentar de novo.</h2>');
    console.error(`\n[autorizar-google] O Google devolveu um erro: ${erro}\n`);
    servidor.close();
    return process.exit(1);
  }

  try {
    const { tokens } = await client.getToken(codigo);

    resposta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    resposta.end('<h2>Autorizado! Pode fechar esta aba e voltar pro terminal.</h2>');

    if (!tokens.refresh_token) {
      console.warn(
        '\n[autorizar-google] O Google NÃO devolveu um refresh_token desta vez.\n'
        + 'Isso costuma acontecer se essa conta já tinha autorizado este app antes.\n'
        + 'Vá em https://myaccount.google.com/permissions, revogue o acesso do\n'
        + 'SAN & CO. e rode este script de novo — na próxima, o Google emite um novo.\n'
      );
    } else {
      console.log('\n[autorizar-google] Autorizado com sucesso.\n');
      console.log('Cole esta linha no seu backend/.env:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }
  } catch (erroTroca) {
    console.error('\n[autorizar-google] Falha ao trocar o código pelo token:', erroTroca.message, '\n');
  } finally {
    servidor.close();
    process.exit(0);
  }
});

servidor.listen(PORTA_TEMPORARIA, () => {
  // nada a fazer aqui — o link já foi impresso acima, antes do servidor subir
});
