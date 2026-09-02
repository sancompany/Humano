/**
 * SAN & CO. — sub-view de detalhamento (dentro do módulo Finanças)
 *
 * NÃO É UMA ABA e NÃO É UM DRAWER. É a terceira sub-tela de Finanças, na
 * rota #/financas/detalhe/<contexto>[/<id>]. Quem a monta é o financeiro.js,
 * que já desenhou o cabeçalho e o seletor PF/PJ.
 *
 * CONTEXTOS
 *   fluxo      — de onde veio e para onde foi o dinheiro do período
 *   faturas    — fatura consolidada por cartão, com compras e pagamentos
 *   projecao   — o que compõe a estimativa
 *   transacao  — uma movimentação específica, por id (#/financas/detalhe/transacao/<id>)
 *
 * FILTROS (contexto 'fluxo')
 *   Fluxo:   [Todos | Entradas | Saídas]        -> reaproveita lenteFinanceira
 *   Período: navegador de mês [‹ Agosto de 2026 ›] mais atalhos
 *            [7D | 15D | Este Mês | Mês Anterior | Personalizado]
 *   Busca:   texto livre por descrição ou valor
 *
 * O agrupamento é sempre por dia — não existe mais um seletor de
 * granularidade [Dias | Mês | Ano]: banco nenhum navega assim, e o
 * navegador de mês já resolve "ver um mês inteiro".
 *
 * Sem dado carregado, tudo aqui rende placeholder ou estado vazio. Nenhum
 * número é inventado: os totais saem sempre da soma dos movimentos.
 */

import { estado, observar, setLenteFinanceira } from '../state.js';
import { carregarFinanceiro, carregarInvestimentos, derivarEvolucaoSaldo,
         resumoPorCategoria, traduzirCategoria, projetosDe }
  from '../dados.js';
import { corDoBanco } from '../bancos.js';
import { svgEvolucaoSaldo, rotuloMesCurto } from '../graficos.js';
import { STATUS_ROTULO, STATUS_COR, htmlSparkline } from './projetos.js';
import { conexaoPorId, situacaoConsentimento, momentoCurto, PRAZO_CONSENTIMENTO } from './conexoes.js';

/* ==================================================================
   1. FORMATAÇÃO
   ================================================================== */
const FORMATO_BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2
});

const VALOR_VAZIO = 'R$ ---.---,--';
const PCT_VAZIO = '---%';

function brl(valor, { sinal = false, positivo = true } = {}) {
  if (!Number.isFinite(valor)) return VALOR_VAZIO;
  const texto = FORMATO_BRL.format(Math.abs(valor));
  return sinal ? `${positivo ? '+' : '−'}\u00A0${texto}` : texto;
}

function brlHtml(valor, opcoes) {
  const texto = brl(valor, opcoes);
  return texto === VALOR_VAZIO
    ? `<span class="valor-vazio" aria-label="valor não carregado">${texto}</span>`
    : texto;
}

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
               'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** '2026-08' -> 'Agosto de 2026' */
function rotuloMes(chave) {
  const [ano, mes] = chave.split('-').map(Number);
  const nome = MESES[mes - 1];
  return `${nome[0].toUpperCase()}${nome.slice(1)} de ${ano}`;
}

/* ==================================================================
   2. PERÍODO BANCÁRIO
   Nada de granularidade abstrata: o extrato é navegado como em banco —
   um mês por vez, com atalhos para as janelas mais usadas.
   ================================================================== */

const ATALHOS = [
  ['7d', '7D'], ['15d', '15D'], ['mes', 'Este Mês'],
  ['anterior', 'Mês Anterior'], ['personalizado', 'Personalizado']
];

/** Estado do período. `mes` guarda qual mês o navegador está exibindo. */
const periodo = {
  modo: 'mes',
  mes: chaveDoMes(new Date()),
  de: null,
  ate: null
};

/** Texto de busca livre, filtra por descrição ou valor. Vive fora de `periodo`
 *  porque não é período — é um filtro ortogonal que combina com qualquer um. */
let busca = '';

function doisDigitos(n) { return String(n).padStart(2, '0'); }

/** Date -> 'AAAA-MM-DD' no fuso local (toISOString viraria o dia). */
function iso(data) {
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
}

/** Date -> 'AAAA-MM' */
function chaveDoMes(data) {
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}`;
}

/** Desloca uma chave de mês. deslocarMes('2026-01', -1) -> '2025-12' */
function deslocarMes(chave, passos) {
  const [ano, mes] = chave.split('-').map(Number);
  const d = new Date(ano, mes - 1 + passos, 1);
  return chaveDoMes(d);
}

/** Hoje à meia-noite local. */
function hoje() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Converte o estado do período no intervalo de datas que filtra o extrato.
 * @returns {{ de: string|null, ate: string|null, rotulo: string }}
 */
function intervalo() {
  const agora = hoje();

  if (periodo.modo === '7d' || periodo.modo === '15d') {
    const dias = periodo.modo === '7d' ? 7 : 15;
    const inicio = new Date(agora);
    inicio.setDate(inicio.getDate() - (dias - 1));
    return { de: iso(inicio), ate: iso(agora), rotulo: `Últimos ${dias} dias` };
  }

  if (periodo.modo === 'personalizado') {
    return { de: periodo.de, ate: periodo.ate, rotulo: 'Período personalizado' };
  }

  // 'mes' e 'anterior' compartilham o navegador: ambos apontam periodo.mes
  const [ano, mes] = periodo.mes.split('-').map(Number);
  const primeiro = new Date(ano, mes - 1, 1);
  const ultimo = new Date(ano, mes, 0);           // dia 0 do mês seguinte
  return { de: iso(primeiro), ate: iso(ultimo), rotulo: rotuloMes(periodo.mes) };
}

/** Filtra por intervalo. Comparar string ISO já ordena corretamente. */
function dentroDoPeriodo(movimentos) {
  const { de, ate } = intervalo();
  return movimentos.filter((m) => {
    if (!m.data) return false;
    if (de && m.data < de) return false;
    if (ate && m.data > ate) return false;
    return true;
  });
}

/**
 * Filtra por texto livre: bate na descrição (contém, sem acento/caixa) ou
 * no valor (dígitos do texto aparecem nos dígitos do valor).
 */
function dentroDaBusca(movimentos) {
  const termo = busca.trim().toLowerCase();
  if (!termo) return movimentos;

  const normalizar = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const termoNorm = normalizar(termo);
  const digitosBusca = termo.replace(/\D/g, '');

  return movimentos.filter((m) => {
    const naDescricao = normalizar(String(m.descricao ?? '').toLowerCase()).includes(termoNorm);
    const noValor = digitosBusca && String(Math.round((m.valor ?? 0) * 100)).includes(digitosBusca);
    return naDescricao || noValor;
  });
}

/** O navegador de mês não avança além do mês corrente. */
function podeAvancar() {
  return periodo.mes < chaveDoMes(new Date());
}

/* ==================================================================
   2.1 AGRUPAMENTO POR DIA
   ================================================================== */

/** Totais de uma lista de movimentos. */
function totalizar(movimentos) {
  const entradas = movimentos.filter((m) => m.tipo === 'entrada')
    .reduce((s, m) => s + (m.valor ?? 0), 0);
  const saidas = movimentos.filter((m) => m.tipo === 'saida')
    .reduce((s, m) => s + (m.valor ?? 0), 0);
  return { entradas, saidas, saldo: entradas - saidas, quantidade: movimentos.length };
}

/** 'Hoje', 'Ontem' ou '12 de agosto' — com o ano quando não é o corrente. */
function rotuloDoDia(chave) {
  const agora = hoje();
  const ontem = new Date(agora);
  ontem.setDate(ontem.getDate() - 1);

  if (chave === iso(agora)) return 'Hoje';
  if (chave === iso(ontem)) return 'Ontem';

  const [ano, mes, dia] = chave.split('-').map(Number);
  const base = `${dia} de ${MESES[mes - 1]}`;
  return ano === agora.getFullYear() ? base : `${base} de ${ano}`;
}

/**
 * Agrupa por dia, do mais recente para o mais antigo, com o balanço de
 * cada dia já calculado.
 */
function agruparPorDia(movimentos) {
  const mapa = new Map();

  movimentos.forEach((mov) => {
    const chave = String(mov.data).slice(0, 10);
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(mov);
  });

  return [...mapa.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([chave, itens]) => ({
      chave,
      rotulo: rotuloDoDia(chave),
      itens,
      ...totalizar(itens)
    }));
}

/* ==================================================================
   3. FRAGMENTOS
   ================================================================== */

const TIPO_DA_LENTE = { entradas: 'entrada', saidas: 'saida' };

function filtrarPorLente(movimentos, lente) {
  const tipo = TIPO_DA_LENTE[lente];
  return tipo ? movimentos.filter((m) => m.tipo === tipo) : movimentos;
}

const TITULOS = {
  fluxo: 'Detalhamento do fluxo',
  faturas: 'Faturas abertas',
  projecao: 'Composição da projeção',
  transacao: 'Movimentação',
  patrimonio: 'Detalhamento do patrimônio',
  ativo: 'Ativo',
  contas: 'Contas bancárias',
  evolucao: 'Evolução do saldo',
  categorias: 'Despesas por categoria',
  projeto: 'Projeto',
  conexao: 'Conexão'
};

/** Ícone de lupa desenhado — mesma técnica da seta do dropzone, sem fonte de ícone. */
const SVG_LUPA = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5"/>
    <line x1="20" y1="20" x2="15.3" y2="15.3"/>
  </svg>`;

/** Navegador de mês + atalhos rápidos — sem wrapper próprio, pra caber
 *  dentro de .detalhe__controles junto com o filtro de fluxo, no Fluxo. */
function htmlBlocoNavMes() {
  const { rotulo } = intervalo();
  return `
    <div class="nav-mes" role="group" aria-label="Navegar por mês">
      <button class="nav-mes__seta" type="button" data-mes="-1"
              aria-label="Mês anterior">&lsaquo;</button>
      <span class="nav-mes__rotulo" data-regiao="periodo-rotulo">${rotulo}</span>
      <button class="nav-mes__seta" type="button" data-mes="1"
              aria-label="Próximo mês" ${podeAvancar() ? '' : 'disabled'}>&rsaquo;</button>
    </div>

    <div class="atalhos" role="group" aria-label="Períodos rápidos">
      ${ATALHOS.map(([valor, texto]) => `
        <button class="atalhos__btn" type="button" data-atalho="${valor}"
                aria-pressed="${periodo.modo === valor}">${texto}</button>
      `).join('')}
    </div>
  `;
}

/** Campo De/Até (só visível em modo Personalizado) + busca textual. */
function htmlBlocoBuscaEPersonalizado() {
  return `
    <div class="intervalo-custom" data-regiao="custom" ${periodo.modo === 'personalizado' ? '' : 'hidden'}>
      <label class="intervalo-custom__campo">
        <span>De</span>
        <input type="date" data-data="de" value="${periodo.de ?? ''}">
      </label>
      <label class="intervalo-custom__campo">
        <span>Até</span>
        <input type="date" data-data="ate" value="${periodo.ate ?? ''}">
      </label>
    </div>

    <label class="busca-extrato">
      ${SVG_LUPA}
      <input type="search" data-busca placeholder="Buscar por descrição ou valor…"
             value="${escapar(busca)}" aria-label="Buscar no extrato">
    </label>
  `;
}

/**
 * Só o filtro [Todos | Entradas | Saídas] — sem wrapper de período. Usado
 * sozinho onde período não se aplica (ex.: dentro de uma fatura, filtrando
 * compras de pagamentos, não um intervalo de datas).
 */
function htmlFiltroLente(lente) {
  return `
    <div class="lentes" role="group" aria-label="Filtro de fluxo">
      ${[['todos', 'Todos'], ['entradas', 'Entradas'], ['saidas', 'Saídas']]
        .map(([valor, texto]) => `
          <button class="lentes__btn" type="button" data-lente="${valor}"
                  aria-pressed="${lente === valor}">${texto}</button>
        `).join('')}
    </div>
  `;
}

/**
 * Fluxo é o único contexto que usa período + fluxo juntos, na mesma
 * estrutura original: nav-mes, atalhos e lentes lado a lado numa única
 * linha, com o campo personalizado e a busca embaixo.
 */
function htmlControles(lente) {
  return `
    <div class="detalhe__controles">
      ${htmlBlocoNavMes()}
      ${htmlFiltroLente(lente)}
    </div>
    ${htmlBlocoBuscaEPersonalizado()}
  `;
}

/** Três KPIs do período: entradas, saídas e resultado.
 *  Resultado é sempre azul — é saldo consolidado, não "bom" ou "ruim" em si;
 *  quem carrega o sinal de bom/ruim é o card de fluxo principal, não este. */
function htmlResumo(totais, temDados) {
  const cartao = (rotulo, valor, faixa) => `
    <article class="card-exec">
      <header class="card-exec__topo">
        <span class="card-exec__label">${rotulo}</span>
      </header>
      <p class="card-exec__valor">${temDados ? brlHtml(valor) : brlHtml(null)}</p>
      <span class="card-exec__faixa card-exec__faixa--${faixa}" aria-hidden="true"></span>
    </article>
  `;

  return `
    <div class="fin-cards fin-cards--tres">
      ${cartao('Entradas do período', totais.entradas, 'positivo')}
      ${cartao('Saídas do período', totais.saidas, 'negativo')}
      ${cartao('Resultado', totais.saldo, 'neutro')}
    </div>
  `;
}

/**
 * Uma movimentação na lista.
 * Clicável: abre o detalhe da transação (contexto 'transacao', por id).
 */
function htmlMovimento(mov) {
  const entrada = mov.tipo === 'entrada';
  const cor = mov.instituicao ? corDoBanco(mov.instituicao) : null;

  return `
    <li class="extrato__item" data-clickable="true"
        role="button" tabindex="0" data-transacao="${mov.id}"
        aria-label="${escapar(mov.descricao ?? 'Movimentação')}, ${brl(mov.valor)}. Abrir detalhe.">
      ${cor ? `<span class="extrato__marca" aria-hidden="true" style="background:${cor}"></span>` : ''}

      <span class="extrato__corpo">
        <span class="extrato__desc">${escapar(mov.descricao ?? 'Sem descrição')}</span>
        <span class="extrato__badges">
          <span class="badge-status badge-status--${mov.status ?? 'liquidado'}">
            ${mov.status === 'pendente' ? 'Pendente' : 'Liquidado'}
          </span>
          ${mov.categoria ? `<span class="badge-categoria">${escapar(mov.categoria)}</span>` : ''}
        </span>
      </span>

      <span class="extrato__valor ${entrada ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
        ${brlHtml(mov.valor, { sinal: true, positivo: entrada })}
      </span>
    </li>
  `;
}

/** Extrato agrupado por cabeçalho diário, com o balanço de cada dia. */
function htmlPorDia(grupos) {
  return grupos.map((grupo) => `
    <section class="periodo">
      <header class="periodo__topo">
        <span class="periodo__rotulo">${grupo.rotulo}</span>
        <span class="periodo__saldo ${grupo.saldo >= 0 ? 'periodo__saldo--sobe' : 'periodo__saldo--desce'}">
          ${brl(grupo.saldo, { sinal: true, positivo: grupo.saldo >= 0 })}
        </span>
      </header>
      <ul class="extrato">${grupo.itens.map(htmlMovimento).join('')}</ul>
    </section>
  `).join('');
}

/** Contexto "Faturas abertas": uma fatura por cartão, com a cor do emissor. */
function htmlFaturas(dados, lente) {
  const cartoes = dados.cartoes?.detalhes ?? [];

  if (!cartoes.length) {
    return htmlVazio('Nenhuma fatura carregada.',
      'As faturas aparecem quando um cartão for sincronizado ou importado.');
  }

  return cartoes.map((cartao) => {
    const cor = corDoBanco(cartao.nome);
    const movimentos = filtrarPorLente(cartao.movimentos ?? [], lente);
    const totais = totalizar(cartao.movimentos ?? []);

    return `
      <section class="fatura">
        <header class="fatura__topo" style="border-left-color: ${cor}">
          <div>
            <p class="fatura__banco" style="color: ${cor}">${escapar(cartao.nome)}</p>
            <p class="fatura__rotulo">Fatura aberta</p>
          </div>
          <p class="fatura__total">${brlHtml(cartao.valor)}</p>
        </header>

        <div class="fatura__resumo">
          <span>Compras <strong class="extrato__valor--saida">${brl(totais.saidas)}</strong></span>
          <span>Pagamentos e estornos <strong class="extrato__valor--entrada">${brl(totais.entradas)}</strong></span>
        </div>

        ${movimentos.length
          ? `<ul class="extrato">${movimentos.map(htmlMovimento).join('')}</ul>`
          : '<p class="extrato__vazio">Nenhum lançamento nesta fatura para o filtro escolhido.</p>'}
      </section>
    `;
  }).join('');
}

/**
 * Contexto "transacao": uma movimentação específica, por id.
 * Ações de editar/excluir são placeholders — não há rota de escrita no
 * backend ainda; ligar quando ela existir.
 */
function htmlTransacao(mov) {
  if (!mov) {
    return htmlVazio('Movimentação não encontrada.',
      'Ela pode ter saído do período carregado ou o link está desatualizado.');
  }

  const entrada = mov.tipo === 'entrada';

  return `
    <article class="transacao-detalhe">
      <p class="transacao-detalhe__valor ${entrada ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
        ${brlHtml(mov.valor, { sinal: true, positivo: entrada })}
      </p>
      <p class="transacao-detalhe__desc">${escapar(mov.descricao ?? 'Sem descrição')}</p>

      <dl class="transacao-detalhe__grade">
        <div><dt>Data</dt><dd>${escapar(mov.data ?? '—')}</dd></div>
        <div><dt>Status</dt><dd>${mov.status === 'pendente' ? 'Pendente' : 'Liquidado'}</dd></div>
        <div><dt>Instituição</dt><dd>${escapar(mov.instituicao ?? 'Não informada')}</dd></div>
        <div><dt>Categoria</dt><dd>${escapar(mov.categoria ?? 'Sem categoria')}</dd></div>
      </dl>

      <div class="transacao-detalhe__acoes">
        <button class="btn" type="button" data-acao="editar-transacao">Editar</button>
        <button class="btn" type="button" data-acao="excluir-transacao">Excluir</button>
      </div>
      <p class="transacao-detalhe__nota">
        Edição e exclusão dependem da gravação no Supabase — ainda não implementada.
      </p>
    </article>
  `;
}

/**
 * Contexto "contas": uma linha por instituição, com o saldo dela. Clicar
 * numa conta filtra o extrato abaixo só para os movimentos daquela
 * conta — usa o mesmo agrupamento por dia da tela de fluxo, não inventa
 * uma visão nova.
 *
 * @param {object} dados
 * @param {string|null} contaFiltro id da conta selecionada, ou null (todas)
 */
function htmlContasDetalhe(dados, contaFiltro) {
  const contas = dados.contas ?? [];

  if (!contas.length) {
    return htmlVazio('Nenhuma conta conectada.',
      'Importe um extrato .OFX na visão geral ou conecte um banco para começar.');
  }

  const total = contas.reduce((s, c) => s + (Number.isFinite(c.saldo) ? c.saldo : 0), 0);

  const linhas = contas.map((c) => `
    <li class="conta-linha ${contaFiltro === c.id ? 'conta-linha--ativa' : ''}"
        data-clickable="true" role="button" tabindex="0" data-conta-filtro="${escapar(c.id)}"
        style="--marca: ${corDoBanco(c.nome)}"
        aria-label="${escapar(c.nome)}, ${brl(c.saldo)}. ${contaFiltro === c.id ? 'Filtro ativo, toque para ver todas.' : 'Filtrar extrato por esta conta.'}">
      <span class="conta-linha__nome">${escapar(c.nome)}</span>
      <span class="conta-linha__saldo">${brlHtml(c.saldo)}</span>
    </li>
  `).join('');

  const movimentosDaConta = contaFiltro
    ? (dados.extrato ?? []).filter((m) => m.contaId === contaFiltro)
    : [];

  const nomeContaFiltro = contas.find((c) => c.id === contaFiltro)?.nome;

  return `
    <div class="card-exec" style="margin-bottom: 20px;">
      <header class="card-exec__topo">
        <span class="card-exec__label">Saldo total</span>
      </header>
      <p class="card-exec__valor">${brlHtml(total)}</p>
      <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
      <ul class="conta-lista">${linhas}</ul>
    </div>

    ${contaFiltro ? `
      <p class="detalhe__filtro-ativo">
        Mostrando só ${escapar(nomeContaFiltro ?? 'esta conta')}
        <button type="button" data-conta-filtro="">Ver todas</button>
      </p>
      ${movimentosDaConta.length
        ? htmlPorDia(agruparPorDia(movimentosDaConta))
        : htmlVazio('Nenhuma movimentação nesta conta ainda.',
            'Os arquivos importados até agora não trazem esse identificador de conta — reimporte o extrato para atualizar.')}
    ` : `
      <p class="section__label">Toque numa conta para ver só o extrato dela</p>
    `}
  `;
}

/**
 * Contexto "evolucao": o mesmo gráfico da Overview, maior, mais uma lista
 * mês a mês com o delta e o saldo acumulado — a tabela por trás do desenho.
 */
function htmlEvolucaoDetalhe(dados) {
  const evolucao = derivarEvolucaoSaldo(dados.extrato ?? [], dados.contas ?? []);

  if (!evolucao.suficiente) {
    return htmlVazio('Ainda não há histórico suficiente.',
      'A evolução aparece a partir de 2 meses de movimentação importada.');
  }

  const linhas = evolucao.pontos.map((p, i) => {
    const anterior = i > 0 ? evolucao.pontos[i - 1].saldo : null;
    const delta = anterior !== null ? p.saldo - anterior : null;
    return `
      <li class="evolucao-linha">
        <span class="evolucao-linha__mes">${rotuloMesCurto(p.mes)}</span>
        <span class="evolucao-linha__delta ${delta === null ? '' : delta >= 0 ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
          ${delta === null ? '—' : brl(delta, { sinal: true, positivo: delta >= 0 })}
        </span>
        <span class="evolucao-linha__saldo">${brl(p.saldo)}</span>
      </li>
    `;
  }).join('');

  return `
    <div class="card-exec card-exec--grafico" style="margin-bottom: 20px;">
      <p class="card-exec__valor">${brlHtml(evolucao.pontos.at(-1).saldo)}</p>
      <p class="card-exec__sub">
        ${evolucao.absoluto
          ? `Saldo atual, ${evolucao.pontos.length} meses`
          : `Variação relativa, ${evolucao.pontos.length} meses — sem saldo de conta para ancorar o valor absoluto`}
      </p>
      ${svgEvolucaoSaldo(evolucao, { altura: 240 })}
    </div>

    <ul class="evolucao-lista">
      <li class="evolucao-linha evolucao-linha--cabecalho">
        <span>Mês</span><span>Variação</span><span>Saldo</span>
      </li>
      ${linhas}
    </ul>
  `;
}

/**
 * Contexto "categorias": os dois blocos que a Pluggy já separa —
 * "Despesas" (liquidadas) e "Despesas futuras" (pendentes) — cada um
 * ranqueado da maior categoria para a menor. Clicar numa categoria filtra
 * o extrato abaixo por ela; clicar de nova limpa o filtro — mesmo padrão
 * já usado no contexto "contas".
 *
 * @param {object} dados
 * @param {string|null} filtro chave "liquidado::Categoria" ou "pendente::Categoria"
 */
function htmlCategoriasDetalhe(dados, filtro) {
  const resumo = resumoPorCategoria(dados.extrato ?? []);

  const bloco = (status, titulo, subtitulo, lista) => {
    if (!lista.length) {
      return `
        <section class="section">
          <p class="section__label">${titulo}</p>
          <p class="extrato__vazio">
            Nenhuma ${status === 'pendente' ? 'despesa pendente' : 'transação categorizada'} no período.
          </p>
        </section>
      `;
    }

    const total = lista.reduce((s, item) => s + item.valor, 0);
    const maior = lista[0]?.valor ?? 0;

    const linhas = lista.map((item) => {
      const chave = `${status}::${item.categoria}`;
      const ativa = filtro === chave;
      return `
        <li class="categoria-linha ${ativa ? 'categoria-linha--ativa' : ''}" data-clickable="true"
            role="button" tabindex="0" data-categoria-filtro="${escapar(chave)}"
            aria-label="${escapar(item.categoria)}, ${brl(item.valor)}. ${ativa ? 'Filtro ativo, toque para ver todas.' : 'Filtrar extrato por esta categoria.'}">
          <div class="categoria-linha__topo">
            <span class="categoria-linha__nome">${escapar(item.categoria)}</span>
            <span class="categoria-linha__valor">${brlHtml(item.valor)}</span>
          </div>
          <div class="categoria-linha__trilho">
            <span class="categoria-linha__barra"
                  style="width: ${maior > 0 ? ((item.valor / maior) * 100).toFixed(1) : 0}%"></span>
          </div>
        </li>
      `;
    }).join('');

    return `
      <section class="section">
        <header class="categoria-bloco__topo">
          <p class="section__label">${titulo}</p>
          <p class="categoria-bloco__total">${brlHtml(total)}</p>
        </header>
        <p class="categoria-bloco__sub">${subtitulo}</p>
        <ul class="categoria-lista categoria-lista--detalhe">${linhas}</ul>
      </section>
    `;
  };

  let movimentosFiltrados = [];
  let nomeFiltro = null;
  if (filtro) {
    const [status, ...resto] = filtro.split('::');
    nomeFiltro = resto.join('::');
    movimentosFiltrados = (dados.extrato ?? []).filter((m) => {
      if (m.tipo !== 'saida') return false;
      const statusMov = m.status === 'pendente' ? 'pendente' : 'liquidado';
      return statusMov === status && traduzirCategoria(m.categoria) === nomeFiltro;
    });
  }

  return `
    ${bloco('liquidado', 'Despesas', 'Transações categorizadas', resumo.liquidado)}
    ${bloco('pendente', 'Despesas futuras', 'Transações pendentes', resumo.pendente)}

    ${filtro ? `
      <p class="detalhe__filtro-ativo">
        Mostrando só ${escapar(nomeFiltro)}
        <button type="button" data-categoria-filtro="">Ver todas</button>
      </p>
      ${movimentosFiltrados.length
        ? htmlPorDia(agruparPorDia(movimentosFiltrados))
        : htmlVazio('Nenhuma movimentação nesta categoria.',
            'Ela pode ter saído do período carregado ou mudado de categoria na origem.')}
    ` : `
      <p class="section__label">Toque numa categoria para ver só o extrato dela</p>
    `}
  `;
}

/**
 * Contexto "projeto": drilldown de um projeto do checkout, por id — os
 * mesmos números do card em js/modules/projetos.js, só que em tela cheia.
 * Nada de gráfico comparativo inventado: só o que moldeProjeto() carrega.
 */
function htmlProjetoDetalhe(projeto) {
  if (!projeto) {
    return htmlVazio('Projeto não encontrado.',
      'Ele pode ter sido removido ou o link está desatualizado.');
  }

  const lucroBom = Number.isFinite(projeto.lucroLiquido) && projeto.lucroLiquido >= 0;

  return `
    <article class="transacao-detalhe">
      <p class="transacao-detalhe__valor ${lucroBom ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
        ${brlHtml(projeto.faturamentoMes)}
      </p>
      <p class="transacao-detalhe__desc">${escapar(projeto.nome)}</p>
      <span class="projeto-card__status" style="--status: ${STATUS_COR[projeto.status]}">
        ${STATUS_ROTULO[projeto.status]}
      </span>

      <dl class="transacao-detalhe__grade" style="margin-top:18px;">
        <div><dt>Categoria</dt><dd>${escapar(projeto.categoria || 'Geral')}</dd></div>
        <div><dt>Escopo</dt><dd>${projeto.escopo === 'comercial' ? 'Comercial / cliente' : 'Pessoal'}</dd></div>
        <div><dt>Lucro líquido</dt><dd class="${!Number.isFinite(projeto.lucroLiquido) ? '' : lucroBom ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">${brlHtml(projeto.lucroLiquido)}</dd></div>
        <div><dt>Margem</dt><dd>${Number.isFinite(projeto.margemLucro) ? `${projeto.margemLucro}%` : '--%'}</dd></div>
        <div><dt>Ticket médio</dt><dd>${brlHtml(projeto.kpis?.ticketMedio)}</dd></div>
        <div><dt>Vendas no mês</dt><dd>${projeto.kpis?.totalVendas ?? 0}</dd></div>
      </dl>

      <section class="section" style="margin-top:18px; text-align:left;">
        <p class="section__label">Faturamento — últimos 6 meses</p>
        ${htmlSparkline(projeto.historico6m ?? [])}
      </section>

      <p class="transacao-detalhe__nota">
        ${projeto.diagnosticoIA
          ? escapar(projeto.diagnosticoIA)
          : 'Lumen Lux ainda não tem diagnóstico — sem IA conectada, nada é dito no lugar dela.'}
      </p>
    </article>
  `;
}

/**
 * Contexto "conexao": "Ver detalhes" de uma conexão bancária, por id.
 * Sem Supabase ainda, `conexoes` está sempre vazio — o estado de
 * "não encontrada" é o caminho real até o backend existir.
 */
function htmlConexaoDetalhe(conexao) {
  if (!conexao) {
    return htmlVazio('Conexão não encontrada.',
      'Ela pode ter sido removida ou ainda não existe — as conexões dependem do Supabase, que ainda não está ligado aqui.');
  }

  const situacao = situacaoConsentimento(conexao);
  const proporcao = situacao.tipo === 'indeterminado'
    ? 100
    : (situacao.dias / PRAZO_CONSENTIMENTO) * 100;

  return `
    <article class="transacao-detalhe">
      <p class="transacao-detalhe__desc" style="color:${corDoBanco(conexao.instituicao)}">
        ${escapar(conexao.instituicao)}
      </p>
      <p class="card-exec__sub">
        ${conexao.ultimaSync ? `Sincronizado ${momentoCurto(conexao.ultimaSync)}` : 'Aguardando 1ª sincronização'}
      </p>

      <div class="consentimento consentimento--${situacao.faixa}" style="margin-top:18px; text-align:left;">
        <div class="consentimento__barra" role="img" aria-label="Consentimento: ${situacao.texto}">
          <span class="consentimento__preenchido" style="width: ${proporcao.toFixed(1)}%"></span>
        </div>
        <p class="consentimento__texto">${situacao.texto}</p>
      </div>

      <dl class="transacao-detalhe__grade" style="margin-top:18px;">
        <div><dt>Perfil</dt><dd>${escapar(conexao.perfil ?? '—')}</dd></div>
        <div><dt>Prazo de consentimento</dt><dd>${conexao.prazo === 'indeterminado' ? 'Indeterminado' : `Anual (${PRAZO_CONSENTIMENTO} dias)`}</dd></div>
      </dl>
    </article>
  `;
}

/**
 * Contexto "projecao": os dois números que o modelo tem de verdade — 7 e
 * 30 dias — e a diferença entre eles. Não existe hoje um dado de "o que
 * compõe a projeção" (recorrências previstas, contas agendadas); em vez
 * de inventar uma lista, a tela admite isso.
 */
function htmlProjecaoDetalhe(dados) {
  const { d7, d30 } = dados.projecao ?? {};
  const temDelta = Number.isFinite(d7) && Number.isFinite(d30);
  const delta = temDelta ? d30 - d7 : null;

  return `
    <div class="fin-cards fin-cards--tres" style="margin-bottom: 20px;">
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Em 7 dias</span></header>
        <p class="card-exec__valor">${brlHtml(d7)}</p>
        <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
      </article>
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Em 30 dias</span></header>
        <p class="card-exec__valor">${brlHtml(d30)}</p>
        <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
      </article>
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Diferença no período</span></header>
        <p class="card-exec__valor">${brlHtml(delta, { sinal: true, positivo: temDelta && delta >= 0 })}</p>
        <span class="card-exec__faixa card-exec__faixa--${!temDelta ? 'neutro' : delta >= 0 ? 'positivo' : 'negativo'}" aria-hidden="true"></span>
      </article>
    </div>
    <p class="detalhe__nota-tecnica">
      O detalhamento por recorrência (o que compõe esses valores, dia a dia)
      depende de dado que a Pluggy ainda não está entregando — assim que
      entrar, esta tela ganha o extrato projetado, não só o total.
    </p>
  `;
}

const COR_CATEGORIA_ATIVO = {
  'Renda Fixa':         'var(--info)',
  'Renda Variável':     'var(--indigo)',
  'Fundos/Previdência': 'var(--success)',
  'Cripto/Outros':      'var(--violeta)'
};

/**
 * Contexto "patrimonio": os três KPIs (investido/liquidez/variação) mais a
 * alocação por classe e a lista de ativos — a mesma leitura de dado que a
 * aba Ativos já tem, só que como destino de clique, não como aba própria.
 * Cada ativo aqui também é clicável, abrindo o contexto "ativo".
 */
function htmlPatrimonioDetalhe(investimentos) {
  if (!investimentos || !investimentos.ativos?.length) {
    return htmlVazio('Nenhum investimento carregado ainda.',
      'A carteira aparece assim que uma conta de investimento for conectada.');
  }

  const variacaoBoa = Number.isFinite(investimentos.variacaoMes) && investimentos.variacaoMes >= 0;

  const alocacao = (investimentos.alocacao ?? []).filter((a) => a.quantidade > 0);
  const barrasAlocacao = alocacao.map((a) => `
    <li class="alocacao__item">
      <div class="alocacao__topo">
        <span class="alocacao__nome" style="color: ${COR_CATEGORIA_ATIVO[a.categoria]}">${a.categoria}</span>
        <span class="alocacao__pct">${Number.isFinite(a.percentual) ? a.percentual.toFixed(1).replace('.', ',') + '%' : '—'}</span>
      </div>
      <div class="alocacao__trilho">
        <span class="alocacao__barra" style="width: ${Number.isFinite(a.percentual) ? a.percentual.toFixed(1) : 0}%; background: ${COR_CATEGORIA_ATIVO[a.categoria]}"></span>
      </div>
      <span class="alocacao__valor">${brlHtml(a.valor)}</span>
    </li>
  `).join('');

  const linhasAtivos = investimentos.ativos.map((a) => {
    const lucro = Number.isFinite(a.rentabilidade_reais) && a.rentabilidade_reais >= 0;
    return `
      <li class="ativo" data-clickable="true" role="button" tabindex="0"
          data-detalhe-ativo="${escapar(a.id)}"
          aria-label="${escapar(a.nome)}, valor atual ${brl(a.valor_atual)}. Abrir detalhe.">
        <span class="ativo__marca" aria-hidden="true" style="background: ${corDoBanco(a.instituicao)}"></span>
        <span class="ativo__corpo">
          <span class="ativo__nome">${escapar(a.nome)}</span>
          <span class="ativo__meta">
            <span style="color: ${corDoBanco(a.instituicao)}">${escapar(a.instituicao)}</span>
            <span class="ativo__categoria">${escapar(a.categoria)}</span>
          </span>
        </span>
        <span class="ativo__numeros">
          <span class="ativo__atual">${brlHtml(a.valor_atual)}</span>
          <span class="ativo__rent ${!Number.isFinite(a.rentabilidade_reais) ? '' : lucro ? 'ativo__rent--positiva' : 'ativo__rent--negativa'}">
            ${brlHtml(a.rentabilidade_reais, { sinal: true })}
          </span>
        </span>
      </li>
    `;
  }).join('');

  return `
    <div class="fin-cards fin-cards--tres" style="margin-bottom: 20px;">
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Total investido</span></header>
        <p class="card-exec__valor">${brlHtml(investimentos.totalInvestido)}</p>
        <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
      </article>
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Liquidez imediata</span></header>
        <p class="card-exec__valor">${brlHtml(investimentos.liquidezImediata)}</p>
        <span class="card-exec__faixa card-exec__faixa--positivo" aria-hidden="true"></span>
      </article>
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Variação do mês</span></header>
        <p class="card-exec__valor">${Number.isFinite(investimentos.variacaoMes) ? `${investimentos.variacaoMes >= 0 ? '+' : '−'}${Math.abs(investimentos.variacaoMes).toFixed(2).replace('.', ',')}%` : brlHtml(null)}</p>
        <span class="card-exec__faixa card-exec__faixa--${!Number.isFinite(investimentos.variacaoMes) ? 'neutro' : variacaoBoa ? 'positivo' : 'negativo'}" aria-hidden="true"></span>
      </article>
    </div>

    ${alocacao.length ? `
      <section class="section">
        <p class="section__label">Alocação por classe</p>
        <ul class="alocacao">${barrasAlocacao}</ul>
      </section>
    ` : ''}

    <section class="section">
      <p class="section__label">Ativos em carteira</p>
      <ul class="ativos">${linhasAtivos}</ul>
    </section>
  `;
}

/** Contexto "ativo": um investimento específico, por id. */
function htmlAtivoDetalhe(ativo) {
  if (!ativo) {
    return htmlVazio('Ativo não encontrado.',
      'Ele pode ter saído da carteira ou o link está desatualizado.');
  }

  const lucro = Number.isFinite(ativo.rentabilidade_reais) && ativo.rentabilidade_reais >= 0;

  return `
    <article class="transacao-detalhe">
      <p class="transacao-detalhe__valor ${lucro ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
        ${brlHtml(ativo.valor_atual)}
      </p>
      <p class="transacao-detalhe__desc">${escapar(ativo.nome)}</p>

      <dl class="transacao-detalhe__grade">
        <div><dt>Instituição</dt><dd style="color:${corDoBanco(ativo.instituicao)}">${escapar(ativo.instituicao)}</dd></div>
        <div><dt>Categoria</dt><dd>${escapar(ativo.categoria)}</dd></div>
        <div><dt>Valor aplicado</dt><dd>${brl(ativo.valor_aplicado)}</dd></div>
        <div><dt>Rentabilidade</dt><dd class="${!Number.isFinite(ativo.rentabilidade_reais) ? '' : lucro ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
          ${brl(ativo.rentabilidade_reais, { sinal: true })}
          ${Number.isFinite(ativo.rentabilidade_pct) ? ` · ${ativo.rentabilidade_pct >= 0 ? '+' : '−'}${Math.abs(ativo.rentabilidade_pct).toFixed(2).replace('.', ',')}%` : ''}
        </dd></div>
        ${ativo.data_vencimento ? `<div><dt>Vencimento</dt><dd>${escapar(ativo.data_vencimento)}</dd></div>` : ''}
      </dl>
    </article>
  `;
}

/** Estado vazio padrão desta tela. */
function htmlVazio(titulo, descricao) {
  return `
    <div class="slot">
      <span class="slot__mark" aria-hidden="true"></span>
      <p class="slot__text"><strong>${titulo}</strong><br>${descricao}</p>
    </div>
  `;
}

/* ==================================================================
   4. MÓDULO
   ================================================================== */
let raiz = null;
let contextoAtual = 'fluxo';
let idAtual = null;
let contaFiltro = null;   // só usado no contexto 'contas'
let categoriaFiltro = null;   // só usado no contexto 'categorias' — "status::Categoria"
let dadosAtuais = null;
let investimentosAtuais = null;   // só usado em 'patrimonio' e 'ativo'
let cancelar = [];
let aoClicar = null;
let aoTeclar = null;
let aoMudarData = null;
let aoDigitarBusca = null;
let ficha = 0;

/** Redesenha só a região de conteúdo — os controles ficam no lugar. */
function desenhar() {
  if (!raiz || !dadosAtuais) return;

  const area = raiz.querySelector('[data-regiao="detalhe-conteudo"]');
  const resumo = raiz.querySelector('[data-regiao="detalhe-resumo"]');

  // "transacao" não usa controles de período/lente — é um item só
  if (contextoAtual === 'transacao') {
    resumo.innerHTML = '';
    const mov = (dadosAtuais.extrato ?? []).find((m) => String(m.id) === String(idAtual));
    area.innerHTML = htmlTransacao(mov);
    return;
  }

  // "contas" e "evolucao" são telas dedicadas — nada de período/lente/busca
  if (contextoAtual === 'contas') {
    resumo.innerHTML = '';
    area.innerHTML = htmlContasDetalhe(dadosAtuais, contaFiltro);
    return;
  }
  if (contextoAtual === 'evolucao') {
    resumo.innerHTML = '';
    area.innerHTML = htmlEvolucaoDetalhe(dadosAtuais);
    return;
  }

  // "categorias": ranking de despesas liquidadas e pendentes — sem período/lente
  if (contextoAtual === 'categorias') {
    resumo.innerHTML = '';
    area.innerHTML = htmlCategoriasDetalhe(dadosAtuais, categoriaFiltro);
    return;
  }

  // "projeto": drilldown de um item do checkout — lê projetosDe(), não dadosAtuais
  if (contextoAtual === 'projeto') {
    resumo.innerHTML = '';
    const projeto = projetosDe(estado.perfil).find((p) => String(p.id) === String(idAtual));
    area.innerHTML = htmlProjetoDetalhe(projeto);
    return;
  }

  // "conexao": "Ver detalhes" de uma conexão bancária, sem período/lente
  if (contextoAtual === 'conexao') {
    resumo.innerHTML = '';
    area.innerHTML = htmlConexaoDetalhe(conexaoPorId(idAtual));
    return;
  }

  // "projecao": só os dois números que existem de verdade — sem período
  if (contextoAtual === 'projecao') {
    resumo.innerHTML = '';
    area.innerHTML = htmlProjecaoDetalhe(dadosAtuais);
    return;
  }

  // "patrimonio" e "ativo" leem investimentosAtuais, não dadosAtuais — são
  // dados de outra natureza (carteira, não fluxo de caixa)
  if (contextoAtual === 'patrimonio') {
    resumo.innerHTML = '';
    area.innerHTML = htmlPatrimonioDetalhe(investimentosAtuais);
    return;
  }
  if (contextoAtual === 'ativo') {
    resumo.innerHTML = '';
    const ativo = (investimentosAtuais?.ativos ?? []).find((a) => String(a.id) === String(idAtual));
    area.innerHTML = htmlAtivoDetalhe(ativo);
    return;
  }

  // "faturas" usa só o filtro de fluxo (compras vs. pagamentos) — sem
  // período, sem busca, então a sincronização de nav-mes não se aplica
  if (contextoAtual === 'faturas') {
    const lenteFatura = estado.lenteFinanceira;
    raiz.querySelectorAll('[data-lente]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.lente === lenteFatura));
    });
    resumo.innerHTML = '';
    area.innerHTML = htmlFaturas(dadosAtuais, lenteFatura);
    return;
  }

  // daqui pra baixo: só o Fluxo, o único contexto que navega o extrato
  // inteiro por período — é onde nav-mes/atalhos/busca fazem sentido
  const lente = estado.lenteFinanceira;

  // controles refletem o estado atual
  raiz.querySelectorAll('[data-lente]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.lente === lente));
  });
  raiz.querySelectorAll('[data-atalho]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.atalho === periodo.modo));
  });

  const rotuloPeriodo = raiz.querySelector('[data-regiao="periodo-rotulo"]');
  if (rotuloPeriodo) rotuloPeriodo.textContent = intervalo().rotulo;

  const avancar = raiz.querySelector('[data-mes="1"]');
  if (avancar) avancar.disabled = !podeAvancar();

  const custom = raiz.querySelector('[data-regiao="custom"]');
  if (custom) custom.hidden = periodo.modo !== 'personalizado';

  const noPeriodo = dentroDoPeriodo(dadosAtuais.extrato ?? []);
  const naBusca = dentroDaBusca(noPeriodo);
  const movimentos = filtrarPorLente(naBusca, lente);
  const totais = totalizar(movimentos);

  resumo.innerHTML = htmlResumo(totais, movimentos.length > 0);

  if (!movimentos.length) {
    area.innerHTML = htmlVazio(
      'Nenhuma transação no período.',
      'Importe um extrato .OFX na visão geral ou conecte um banco para começar.'
    );
    return;
  }

  area.innerHTML = htmlPorDia(agruparPorDia(movimentos));
}

async function carregar() {
  const meuTurno = ++ficha;
  // busca os dois em paralelo — 'patrimonio' e 'ativo' precisam de
  // investimentos, os demais contextos de dadosAtuais; nenhum dos dois é
  // caro (offline devolve o molde vazio na hora), então sempre buscar os
  // dois é mais simples do que decidir por contexto e arriscar esquecer
  const [dados, investimentos] = await Promise.all([
    carregarFinanceiro(estado.perfil),
    carregarInvestimentos(estado.perfil)
  ]);
  if (meuTurno !== ficha || !raiz) return;
  dadosAtuais = dados;
  investimentosAtuais = investimentos;
  desenhar();
}

const detalhe = {
  id: 'detalhe',

  /**
   * @param {string} contexto fluxo | faturas | projecao | transacao
   * @param {string|null} id só usado no contexto 'transacao'
   * @returns {HTMLElement} só o conteúdo — o cabeçalho é do financeiro.js
   */
  render(contexto = 'fluxo', id = null) {
    contextoAtual = contexto;
    idAtual = id;

    const bloco = document.createElement('div');
    bloco.dataset.subtela = 'detalhe';
    bloco.id = 'financial-detail-view';

    bloco.innerHTML = `
      <a class="btn-back" href="#/financas">
        <span aria-hidden="true">&lsaquo;</span> Voltar para Visão Geral
      </a>

      <p class="detalhe__titulo">${TITULOS[contexto] ?? 'Detalhamento'}</p>

      ${contexto === 'fluxo' ? htmlControles(estado.lenteFinanceira)
        : contexto === 'faturas' ? htmlFiltroLente(estado.lenteFinanceira)
        : ''}

      <div data-regiao="detalhe-resumo"></div>
      <div data-regiao="detalhe-conteudo"></div>
    `;

    return bloco;
  },

  mount(bloco, id = null) {
    raiz = bloco;
    if (id !== null) idAtual = id;

    aoClicar = (evento) => {
      const lente = evento.target.closest('[data-lente]');
      if (lente) return setLenteFinanceira(lente.dataset.lente);

      // navegador de mês: mexer nas setas devolve o modo para o mês
      const seta = evento.target.closest('[data-mes]');
      if (seta && !seta.disabled) {
        periodo.mes = deslocarMes(periodo.mes, Number(seta.dataset.mes));
        periodo.modo = 'mes';
        return desenhar();
      }

      const atalho = evento.target.closest('[data-atalho]');
      if (atalho) {
        const modo = atalho.dataset.atalho;
        periodo.modo = modo;

        // "Este Mês" e "Mês Anterior" reposicionam o navegador
        if (modo === 'mes') periodo.mes = chaveDoMes(new Date());
        if (modo === 'anterior') {
          periodo.mes = deslocarMes(chaveDoMes(new Date()), -1);
          periodo.modo = 'mes';
        }
        return desenhar();
      }

      // clique numa transação: navega para o detalhe dela
      const linha = evento.target.closest('[data-transacao]');
      if (linha) {
        window.location.hash = `#/financas/detalhe/transacao/${encodeURIComponent(linha.dataset.transacao)}`;
        return;
      }

      // clique num ativo, dentro da tela de Patrimônio: abre o dele
      const ativoAlvo = evento.target.closest('[data-detalhe-ativo]');
      if (ativoAlvo) {
        window.location.hash = `#/financas/detalhe/ativo/${encodeURIComponent(ativoAlvo.dataset.detalheAtivo)}`;
        return;
      }

      // contexto "contas": clicar filtra o extrato por aquela conta;
      // clicar de novo (ou no botão "Ver todas") limpa o filtro
      const contaAlvo = evento.target.closest('[data-conta-filtro]');
      if (contaAlvo) {
        const id = contaAlvo.dataset.contaFiltro;
        contaFiltro = (!id || contaFiltro === id) ? null : id;
        return desenhar();
      }

      // contexto "categorias": mesmo padrão de "contas" — clicar filtra,
      // clicar de novo (ou "Ver todas") limpa
      const categoriaAlvo = evento.target.closest('[data-categoria-filtro]');
      if (categoriaAlvo) {
        const chave = categoriaAlvo.dataset.categoriaFiltro;
        categoriaFiltro = (!chave || categoriaFiltro === chave) ? null : chave;
        return desenhar();
      }

      // ações da tela de transação — sem backend de escrita ainda
      if (evento.target.closest('[data-acao="editar-transacao"]')) {
        console.info('[detalhe] editar transação — sem rota de escrita ainda.');
        return;
      }
      if (evento.target.closest('[data-acao="excluir-transacao"]')) {
        console.info('[detalhe] excluir transação — sem rota de escrita ainda.');
        return;
      }
    };

    // itens de extrato não são <button>: o teclado precisa de ajuda
    aoTeclar = (evento) => {
      if (evento.key !== 'Enter' && evento.key !== ' ') return;

      const linha = evento.target.closest('[data-transacao]');
      if (linha) {
        evento.preventDefault();
        window.location.hash = `#/financas/detalhe/transacao/${encodeURIComponent(linha.dataset.transacao)}`;
        return;
      }

      const ativoAlvo = evento.target.closest('[data-detalhe-ativo]');
      if (ativoAlvo) {
        evento.preventDefault();
        window.location.hash = `#/financas/detalhe/ativo/${encodeURIComponent(ativoAlvo.dataset.detalheAtivo)}`;
        return;
      }

      const contaAlvo = evento.target.closest('[data-conta-filtro]');
      if (contaAlvo) {
        evento.preventDefault();
        const id = contaAlvo.dataset.contaFiltro;
        contaFiltro = (!id || contaFiltro === id) ? null : id;
        return desenhar();
      }

      const categoriaAlvo = evento.target.closest('[data-categoria-filtro]');
      if (categoriaAlvo) {
        evento.preventDefault();
        const chave = categoriaAlvo.dataset.categoriaFiltro;
        categoriaFiltro = (!chave || categoriaFiltro === chave) ? null : chave;
        desenhar();
      }
    };

    // campos De/Até do período personalizado
    aoMudarData = (evento) => {
      const campo = evento.target.closest('[data-data]');
      if (!campo) return;
      periodo[campo.dataset.data] = campo.value || null;
      periodo.modo = 'personalizado';
      desenhar();
    };

    // busca textual — filtra a cada tecla
    aoDigitarBusca = (evento) => {
      const campo = evento.target.closest('[data-busca]');
      if (!campo) return;
      busca = campo.value;
      desenhar();
    };

    bloco.addEventListener('click', aoClicar);
    bloco.addEventListener('keydown', aoTeclar);
    bloco.addEventListener('change', aoMudarData);
    bloco.addEventListener('input', aoDigitarBusca);

    cancelar = [
      observar('lenteFinanceira', () => desenhar()),
      observar('perfil', () => carregar())
    ];

    carregar();
  },

  unmount() {
    cancelar.forEach((parar) => parar());
    cancelar = [];
    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
      raiz.removeEventListener('keydown', aoTeclar);
      raiz.removeEventListener('change', aoMudarData);
      raiz.removeEventListener('input', aoDigitarBusca);
    }
    aoClicar = null;
    aoTeclar = null;
    aoMudarData = null;
    aoDigitarBusca = null;
    raiz = null;
    dadosAtuais = null;
    investimentosAtuais = null;
    idAtual = null;
    contaFiltro = null;
    categoriaFiltro = null;
    ficha += 1;
  }
};

export default detalhe;
