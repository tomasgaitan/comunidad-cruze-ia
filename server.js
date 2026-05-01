require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IP_LIMIT = 5;
const GLOBAL_LIMIT = 50;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// --- Estado en memoria (cargado desde disco al iniciar) ---
// Evita leer archivos en cada request y elimina race conditions de I/O.

let cacheStore = [];
let rateStore = { date: '', global: 0, ips: {} };

function today() {
  return new Date().toISOString().slice(0, 10);
}


// --- Cache helpers ---

function normalizeQuery(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findCacheEntry(query) {
  const norm = normalizeQuery(query);
  const cutoff = Date.now() - CACHE_TTL_MS;
  return cacheStore.find(
    e => e.query === norm && new Date(e.timestamp).getTime() > cutoff
  ) || null;
}

function saveCacheEntry(query, answer, sources) {
  cacheStore.push({
    query: normalizeQuery(query),
    answer,
    sources,
    timestamp: new Date().toISOString(),
  });
}

// --- Rate limit helpers ---

function ensureTodayRate() {
  if (rateStore.date !== today()) {
    rateStore = { date: today(), global: 0, ips: {} };
  }
}

function getRemainingForIp(ip) {
  ensureTodayRate();
  return Math.max(0, IP_LIMIT - (rateStore.ips[ip] || 0));
}

function checkAndIncrement(ip) {
  ensureTodayRate();

  if (rateStore.global >= GLOBAL_LIMIT) {
    return { allowed: false, reason: 'global' };
  }

  const ipUsed = rateStore.ips[ip] || 0;
  if (ipUsed >= IP_LIMIT) {
    return { allowed: false, reason: 'ip' };
  }

  rateStore.global += 1;
  rateStore.ips[ip] = ipUsed + 1;

  return { allowed: true, remaining: IP_LIMIT - rateStore.ips[ip] };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || 'unknown';
}

// --- Search & AI ---

async function searchGoogle(query) {
  const response = await axios.get('https://serpapi.com/search', {
    params: {
      engine: 'google',
      q: `Chevrolet Cruze ${query}`,
      hl: 'es',
      gl: 'ar',
      num: 8,
      api_key: process.env.SERPAPI_KEY,
    },
  });
  return response.data.organic_results || [];
}

function buildSourcesContext(results) {
  return results
    .map((item, i) => {
      const snippet = item.snippet || '';
      return `[${i + 1}] ${item.title}\nURL: ${item.link}\n${snippet}`;
    })
    .join('\n\n');
}

// --- Routes ---

app.get('/api/quota', (req, res) => {
  const ip = getClientIp(req);
  res.json({ remaining: getRemainingForIp(ip) });
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'La consulta no puede estar vacía.' });
  }

  const ip = getClientIp(req);
  const trimmedQuery = query.trim();

  // Cache hit: no consume cuota
  const cached = findCacheEntry(trimmedQuery);
  if (cached) {
    console.log(`[CACHE HIT] "${normalizeQuery(trimmedQuery)}"`);
    return res.json({
      answer: cached.answer,
      sources: cached.sources,
      fromCache: true,
      remaining: getRemainingForIp(ip),
    });
  }

  console.log(`[CACHE MISS] "${normalizeQuery(trimmedQuery)}"`);

  // Verificar y consumir cuota
  const limit = checkAndIncrement(ip);
  if (!limit.allowed) {
    const error = limit.reason === 'global'
      ? 'El servicio alcanzó el límite diario. Volvé mañana.'
      : 'Alcanzaste el límite de 5 consultas por hoy. Volvé mañana.';
    return res.status(429).json({ error, remaining: 0 });
  }

  try {
    const searchResults = await searchGoogle(trimmedQuery);

    if (searchResults.length === 0) {
      return res.json({
        answer: 'No encontré resultados relevantes para tu consulta. Intentá reformular la pregunta.',
        sources: [],
        remaining: limit.remaining,
      });
    }

    const sourcesContext = buildSourcesContext(searchResults);

    const systemPrompt = `Sos un experto mecánico y entusiasta del Chevrolet Cruze. Tu misión es ayudar a los propietarios y entusiastas del Cruze respondiendo sus preguntas de forma clara, práctica y en español rioplatense.

Usá los resultados de búsqueda proporcionados como base para tu respuesta. Sé específico, menciona modelos y años cuando sea relevante, y citá las fuentes usando el número entre corchetes [N].

Estructura tu respuesta en secciones cuando aplique. Usá un tono amigable y cercano, como si fueras un mecánico de confianza.`;

    const userMessage = `Pregunta del usuario sobre el Chevrolet Cruze: "${trimmedQuery}"

Resultados de búsqueda encontrados:

${sourcesContext}

Respondé la pregunta basándote en estos resultados. Citá las fuentes relevantes con [N].`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const answer = message.content[0].text;

    const sources = searchResults.map((item, i) => ({
      index: i + 1,
      title: item.title,
      link: item.link,
      snippet: item.snippet || '',
      displayLink: item.displayed_link || item.link,
    }));

    // Guardar en caché antes de responder; si falla, igual respondemos
    try {
      saveCacheEntry(trimmedQuery, answer, sources);
    } catch (cacheErr) {
      console.error('Error guardando en caché:', cacheErr.message);
    }

    return res.json({ answer, sources, remaining: limit.remaining });
  } catch (err) {
    console.error('Error en /api/search:', err.message);

    if (err.response?.status === 429) {
      return res.status(429).json({ error: 'Límite de búsquedas alcanzado. Intentá de nuevo en unos minutos.' });
    }

    if (err.status === 401) {
      return res.status(500).json({ error: 'Error de autenticación con la API de Claude. Verificá tu API key.' });
    }

    return res.status(500).json({ error: 'Ocurrió un error al procesar tu consulta. Intentá de nuevo.' });
  }
});

// Fallback: cualquier error no manejado responde JSON (evita HTML de Express)
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Comunidad Cruze IA corriendo en http://localhost:${port}`);
  });
}

module.exports = app;
