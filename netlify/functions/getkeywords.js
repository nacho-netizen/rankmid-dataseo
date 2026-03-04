// netlify/functions/getKeywords.js
// Variables de entorno necesarias en Netlify:
//   DATAFORSEO_LOGIN   → tu email de DataForSEO
//   DATAFORSEO_PASSWORD → tu contraseña de DataForSEO
//   OPENAI_API_KEY     → tu API key de OpenAI

const DATAFORSEO_API = 'https://api.dataforseo.com';
const OPENAI_API     = 'https://api.openai.com/v1/chat/completions';

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD, OPENAI_API_KEY } = process.env;

  console.log('LOGIN existe:', !!DATAFORSEO_LOGIN);
  console.log('PASSWORD existe:', !!DATAFORSEO_PASSWORD);
  console.log('OPENAI existe:', !!OPENAI_API_KEY);

  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Credenciales de DataForSEO no configuradas', login: !!DATAFORSEO_LOGIN, password: !!DATAFORSEO_PASSWORD }) };

  if (!OPENAI_API_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API Key de OpenAI no configurada' }) };
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Credenciales de DataForSEO no configuradas' }) };

  if (!OPENAI_API_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API Key de OpenAI no configurada' }) };

  // ── Parseo del body ───────────────────────────────────────
  let keyword, country_code, language_code;
  try {
    ({ keyword, country_code = 2724, language_code = 'es' } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  if (!keyword?.trim())
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'La palabra clave es obligatoria' }) };

  // ── 1. DataForSEO: volumen, CPC y KD ─────────────────────
  let dataforseoData = null;
  let keywordMetrics  = null;

  try {
    const b64 = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');

    // Search Volume + CPC + Competition
    const svRes = await fetch(`${DATAFORSEO_API}/v3/keywords_data/google/search_volume/live`, {
      method:  'POST',
      headers: { 'Authorization': `Basic ${b64}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keywords:      [keyword.trim()],
        location_code: Number(country_code),
        language_code: language_code,
        date_from:     getPreviousMonth()
      }])
    });
    const svJson = await svRes.json();
    const svItem = svJson?.tasks?.[0]?.result?.[0];

    // Keyword Difficulty
    const kdRes = await fetch(`${DATAFORSEO_API}/v3/keywords_data/google/keyword_difficulty/live`, {
      method:  'POST',
      headers: { 'Authorization': `Basic ${b64}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keywords:      [keyword.trim()],
        location_code: Number(country_code),
        language_code: language_code
      }])
    });
    const kdJson = await kdRes.json();
    const kdItem  = kdJson?.tasks?.[0]?.result?.[0];

    // Related Keywords (para sugerencias)
    const relRes = await fetch(`${DATAFORSEO_API}/v3/keywords_data/google/keyword_suggestions/live`, {
      method:  'POST',
      headers: { 'Authorization': `Basic ${b64}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keyword:       keyword.trim(),
        location_code: Number(country_code),
        language_code: language_code,
        limit:         15
      }])
    });
    const relJson = await relRes.json();
    const relItems = relJson?.tasks?.[0]?.result || [];

    keywordMetrics = {
      keyword:      keyword.trim(),
      search_volume: svItem?.search_volume        ?? 0,
      cpc:           svItem?.cpc                  ?? 0,
      competition:   svItem?.competition          ?? 0,   // 0-1
      difficulty:    kdItem?.keyword_difficulty   ?? 0,   // 0-100
      trend:         svItem?.monthly_searches     ?? [],
      related:       relItems.slice(0, 15).map(r => ({
        keyword:    r.keyword,
        volume:     r.search_volume ?? 0,
        cpc:        r.cpc           ?? 0,
        difficulty: r.keyword_difficulty ?? 0,
        intent:     detectIntent(r.keyword)
      }))
    };

    dataforseoData = keywordMetrics;

  } catch (err) {
    console.error('DataForSEO error:', err.message);
    // No bloqueamos: seguimos con datos parciales y dejamos que OpenAI analice lo que hay
    keywordMetrics = { keyword: keyword.trim(), error: err.message };
  }

  // ── 2. OpenAI: análisis semántico ─────────────────────────
  let semanticAnalysis = null;
  try {
    const systemPrompt = `Eres un consultor SEO senior especializado en el mercado español.
Recibirás datos de una palabra clave extraídos de DataForSEO.
Tu tarea es generar un resumen ejecutivo breve (máximo 60 palabras) sobre:
- Intención de búsqueda predominante
- Potencial de conversión
- 5 términos LSI (Latent Semantic Indexing) específicos y relevantes, no genéricos

Responde ÚNICAMENTE con un objeto JSON válido, sin markdown:
{
  "resumen": "texto del análisis en 60 palabras máximo",
  "intencion": "informacional|transaccional|comercial|navegacional",
  "potencial_conversion": "bajo|medio|alto",
  "terminos_lsi": ["término1","término2","término3","término4","término5"]
}`;

    const userMessage = `Analiza esta palabra clave para el mercado español:
Palabra clave: ${keyword}
Volumen mensual: ${keywordMetrics?.search_volume ?? 'desconocido'}
CPC medio: ${keywordMetrics?.cpc ? keywordMetrics.cpc + '€' : 'desconocido'}
Competencia (0-1): ${keywordMetrics?.competition ?? 'desconocida'}
Dificultad KD (0-100): ${keywordMetrics?.difficulty ?? 'desconocida'}
Keywords relacionadas principales: ${keywordMetrics?.related?.slice(0,5).map(r=>r.keyword).join(', ') ?? 'no disponibles'}`;

    const oaiRes = await fetch(OPENAI_API, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o',
        temperature: 0.3,
        max_tokens:  400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  }
        ]
      })
    });

    const oaiJson = await oaiRes.json();
    const rawText = oaiJson?.choices?.[0]?.message?.content || '';

    // Limpiar posibles bloques markdown
    const clean = rawText.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    semanticAnalysis = JSON.parse(clean);

  } catch (err) {
    console.error('OpenAI error:', err.message);
    semanticAnalysis = {
      resumen:              'No se pudo generar el análisis semántico automático.',
      intencion:            detectIntent(keyword),
      potencial_conversion: 'medio',
      terminos_lsi:         []
    };
  }

  // ── 3. Construir respuesta final ──────────────────────────
  const response = buildResponse(keyword, keywordMetrics, semanticAnalysis);
  return { statusCode: 200, headers, body: JSON.stringify(response) };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPreviousMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

function detectIntent(kw) {
  const k = (kw || '').toLowerCase();
  if (/comprar|precio|oferta|barato|envío|tienda|shop|buy|order/.test(k))   return 'transaccional';
  if (/mejor|comparar|versus|vs|review|opinión|alternativa/.test(k))         return 'comercial';
  if (/www\.|\.com|\.es|marca|oficial|login|acceder/.test(k))                return 'navegacional';
  return 'informacional';
}

function formatVolume(v) {
  if (!v || v === 0) return 'N/D';
  if (v >= 1000000) return (v/1000000).toFixed(1)+'M';
  if (v >= 1000)    return (v/1000).toFixed(0)+'K';
  return String(v);
}

function buildResponse(keyword, metrics, semantic) {
  const diff       = metrics?.difficulty   ?? 0;
  const volume     = metrics?.search_volume ?? 0;
  const cpc        = metrics?.cpc           ?? 0;
  const competition = metrics?.competition  ?? 0;

  // Calcular potencial (1-10) combinando volumen y CPC
  const volScore = Math.min(5, Math.log10(volume+1));
  const cpcScore = Math.min(5, cpc * 1.5);
  const potential = Math.max(1, Math.min(10, Math.round(volScore + cpcScore)));

  return {
    palabra_clave: {
      keyword,
      dificultad:      diff,
      potencial:       potential,
      intencion:       semantic?.intencion            ?? detectIntent(keyword),
      volumen:         formatVolume(volume),
      volumen_raw:     volume,
      cpc:             cpc ? cpc.toFixed(2)+'€' : 'N/D',
      competencia:     Math.round(competition * 100) + '%',
      tipo_contenido:  getContentType(semantic?.intencion ?? detectIntent(keyword))
    },
    analisis_semantico: semantic?.resumen ?? '',
    potencial_conversion: semantic?.potencial_conversion ?? 'medio',
    terminos_lsi:      semantic?.terminos_lsi ?? [],
    palabras_clave_relacionadas: (metrics?.related || []).map(r => ({
      keyword:    r.keyword,
      dificultad: r.difficulty,
      intencion:  r.intent || detectIntent(r.keyword),
      volumen:    formatVolume(r.volume),
      cpc:        r.cpc ? r.cpc.toFixed(2)+'€' : 'N/D'
    })),
    preguntas:      generateQuestions(keyword),
    ideas_contenido: generateContentIdeas(keyword, semantic?.intencion ?? detectIntent(keyword)),
    analisis_serp:  generateSerpAnalysis(keyword, diff, semantic?.intencion ?? detectIntent(keyword)),
    competidores: [
      { tipo: diff > 60 ? 'Portales de referencia' : 'Blogs especializados', descripcion: diff > 60 ? 'DA 70+, años de autoridad' : 'Nichos bien posicionados' },
      { tipo: 'Medios digitales',    descripcion: 'Tráfico masivo, contenido generalista' },
      { tipo: competition > 0.6 ? 'E-commerce consolidados' : 'Tiendas nicho', descripcion: competition > 0.6 ? 'Alta inversión en paid' : 'SEO como canal principal' }
    ]
  };
}

function getContentType(intent) {
  const map = {
    informacional: 'Artículo de blog / Guía completa',
    transaccional: 'Landing page de producto o servicio',
    comercial:     'Página comparativa / Artículo de review',
    navegacional:  'Página de marca / Página de inicio'
  };
  return map[intent] || 'Artículo de blog';
}

function generateQuestions(kw) {
  return [
    `¿Qué es ${kw} y para qué sirve?`,
    `¿Cómo empezar con ${kw} desde cero?`,
    `¿Cuánto cuesta ${kw} en España?`,
    `¿Cuáles son las mejores herramientas de ${kw}?`,
    `¿Es rentable apostar por ${kw} en ${new Date().getFullYear()}?`
  ];
}

function generateContentIdeas(kw, intent) {
  const year = new Date().getFullYear();
  return [
    `Guía definitiva de ${kw}: todo lo que necesitas saber en ${year}`,
    `${kw}: los ${intent==='transaccional'?'mejores productos':'errores más comunes'} que debes conocer`,
    `Cómo usar ${kw} para ${intent==='transaccional'?'aumentar tus ventas':'mejorar tu posicionamiento'} paso a paso`,
    `Las mejores herramientas de ${kw} (comparativa actualizada ${year})`,
    `${kw} para principiantes: empieza hoy con esta hoja de ruta`
  ];
}

function generateSerpAnalysis(kw, diff, intent) {
  const nivel = diff > 60 ? 'sitios de alta autoridad de dominio (DA 50+)' : 'blogs especializados y sitios medianos';
  const estrategia = intent === 'informacional'
    ? 'contenido exhaustivo con estructura clara, datos actualizados y elementos multimedia'
    : 'páginas orientadas a la conversión con prueba social, comparativas y llamadas a la acción claras';
  return `En las SERPs de "${kw}" predominan ${nivel}. La estrategia recomendada es crear ${estrategia} para diferenciarte de la competencia.`;
}
