/**
 * SAN & CO. — backend/server.js
 * Ponto de entrada. Sem este arquivo rodando, `financasRepo.js` e
 * `mcpTools.js` são só texto — nada os executa.
 *
 * COMO RODAR (na pasta san-and-co/):
 *   1. npm install
 *   2. copie .env.example para .env e cole sua GEMINI_API_KEY ali dentro
 *   3. npm start
 *
 * O front-end (Live Server, 127.0.0.1:5500) nunca fala com a Gemini
 * direto — sempre por aqui. A chave nunca sai deste processo.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// TODO: reativar quando o Supabase estiver configurado (SUPABASE_URL e
// SUPABASE_KEY no .env). Hoje financasRepo.js cria o cliente Supabase assim
// que é carregado — sem essas variáveis, importar rotasMcp derruba o
// servidor inteiro, mesmo essa rota não sendo necessária pra Miriel.
// import rotasMcp from './routes/mcp.js';
import rotasPanteao from './routes/panteao.js';
import rotasGoogle from './routes/google.js';
import rotasFinancas from './routes/financas.js';
import rotasWhatsapp from './routes/whatsapp.js';

const app = express();
const PORTA = process.env.PORT || 3000;

/**
 * CORS liberado só para a origem do Live Server. Trocar a porta do Live
 * Server (ou publicar o front em outro domínio depois) exige atualizar
 * isto — CORS não adivinha, ele bloqueia por padrão de propósito.
 */
app.use(cors({ origin: process.env.ORIGEM_FRONTEND || 'http://127.0.0.1:5500' }));
app.use(express.json());

// app.use('/api/mcp', rotasMcp);   // desligado — ver o comentário no import acima
app.use('/api/panteao', rotasPanteao);
app.use('/api/google', rotasGoogle);
app.use('/api/financas', rotasFinancas);
app.use('/api/whatsapp', rotasWhatsapp);

app.get('/api/saude', (_req, resposta) => {
  resposta.json({
    status: 'ok',
    chaveGeminiConfigurada: Boolean(process.env.GEMINI_API_KEY),
    googleAutorizado: Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    supabaseConfigurado: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  });
});

app.listen(PORTA, () => {
  console.log(`[backend] SAN & CO. ouvindo em http://localhost:${PORTA}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[backend] GEMINI_API_KEY não encontrada no .env — as chamadas à Miriel vão falhar.');
  }
});
