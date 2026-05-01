require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { Redis } = require('@upstash/redis');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const IP_LIMIT = 5;
const GLOBAL_LIMIT = 50;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECENT = 20;

let cacheStore = [];
let recentQueries = [];

function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- Cache helpers (en memoria) ---

const STOP_WORDS = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','en','a','al',
  'con','por','para','qué','que','cómo','como','cuál','cual','cuales',
  'es','son','se','me','mi','su','sus','y','o','no','si','le','lo','uso',
  'usa','usar','tiene','hay','puedo','debo','dónde','donde','cuando','cuándo',
]);

function normalizeQuery(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function extractKeywords(q) {
  return normalizeQuery(q)
    .split(' ')
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function findCacheEntry(query) {
  const norm = normalizeQuery(query);
  const cutoff = Date.now() - CACHE_TTL_MS;
  const valid = cacheStore.filter(e => new Date(e.timestamp).getTime() > cutoff);

  const exact = valid.find(e => e.query === norm);
  if (exact) return exact;

  const keywords = extractKeywords(query);
  if (keywords.length === 0) return null;

  return valid.find(e => {
    const matches = keywords.filter(k => e.query.includes(k)).length;
    return matches / keywords.length >= 0.60;
  }) || null;
}

function saveCacheEntry(query, answer, sources) {
  cacheStore.push({
    query: normalizeQuery(query),
    answer,
    sources,
    timestamp: new Date().toISOString(),
  });
}

function addRecentQuery(query) {
  recentQueries = [query, ...recentQueries.filter(q => q !== query)].slice(0, MAX_RECENT);
}

// --- Stats en Redis ---

async function incrStat(key) {
  await redis.incr(`stats:${key}`);
}

async function getStats() {
  const [serpapi, claude, cacheHits, cacheMisses, rateLimitBlocks, startedAt] = await Promise.all([
    redis.get('stats:serpapi'),
    redis.get('stats:claude'),
    redis.get('stats:cacheHits'),
    redis.get('stats:cacheMisses'),
    redis.get('stats:rateLimitBlocks'),
    redis.get('stats:startedAt'),
  ]);

  if (!startedAt) {
    await redis.set('stats:startedAt', new Date().toISOString());
  }

  return {
    serpapi: serpapi || 0,
    claude: claude || 0,
    cacheHits: cacheHits || 0,
    cacheMisses: cacheMisses || 0,
    rateLimitBlocks: rateLimitBlocks || 0,
    startedAt: startedAt || new Date().toISOString(),
  };
}

// --- Rate limit en Redis ---

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || 'unknown';
}

async function getRemainingForIp(ip) {
  const ipCount = await redis.get(`rate:ip:${today()}:${ip}`);
  return Math.max(0, IP_LIMIT - (ipCount || 0));
}

async function checkAndIncrement(ip) {
  const globalKey = `rate:global:${today()}`;
  const ipKey = `rate:ip:${today()}:${ip}`;

  const [globalCount, ipCount] = await Promise.all([
    redis.get(globalKey),
    redis.get(ipKey),
  ]);

  if ((globalCount || 0) >= GLOBAL_LIMIT) {
    return { allowed: false, reason: 'global' };
  }
  if ((ipCount || 0) >= IP_LIMIT) {
    return { allowed: false, reason: 'ip' };
  }

  await Promise.all([
    redis.incr(globalKey),
    redis.incr(ipKey),
    redis.expire(globalKey, 172800),
    redis.expire(ipKey, 172800),
  ]);

  return { allowed: true, remaining: IP_LIMIT - ((ipCount || 0) + 1) };
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

app.get('/api/recent-queries', (req, res) => {
  res.json({ queries: recentQueries });
});

app.get('/api/quota', async (req, res) => {
  const ip = getClientIp(req);
  const remaining = await getRemainingForIp(ip);
  res.json({ remaining });
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'La consulta no puede estar vacía.' });
  }

  const ip = getClientIp(req);
  const trimmedQuery = query.trim();

  const cached = findCacheEntry(trimmedQuery);
  if (cached) {
    await incrStat('cacheHits');
    return res.json({
      answer: cached.answer,
      sources: cached.sources,
      fromCache: true,
      remaining: await getRemainingForIp(ip),
    });
  }

  await incrStat('cacheMisses');

  const limit = await checkAndIncrement(ip);
  if (!limit.allowed) {
    await incrStat('rateLimitBlocks');
    const error = limit.reason === 'global'
      ? 'El servicio alcanzó el límite diario. Volvé mañana.'
      : 'Alcanzaste el límite de 5 consultas por hoy. Volvé mañana.';
    return res.status(429).json({ error, remaining: 0 });
  }

  try {
    const searchResults = await searchGoogle(trimmedQuery);
    await incrStat('serpapi');

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
    await incrStat('claude');

    const sources = searchResults.map((item, i) => ({
      index: i + 1,
      title: item.title,
      link: item.link,
      snippet: item.snippet || '',
      displayLink: item.displayed_link || item.link,
    }));

    try {
      saveCacheEntry(trimmedQuery, answer, sources);
      addRecentQuery(trimmedQuery);
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

app.get('/api/admin/stats', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  const [s, globalUsageToday, uniqueIpsRaw] = await Promise.all([
    getStats(),
    redis.get(`rate:global:${today()}`),
    redis.keys(`rate:ip:${today()}:*`),
  ]);
  res.json({
    ...s,
    cacheSize: cacheStore.length,
    globalUsageToday: globalUsageToday || 0,
    uniqueIpsToday: uniqueIpsRaw.length,
  });
});

app.post('/api/admin/reset-ip', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  const ip = getClientIp(req);
  await redis.del(`rate:ip:${today()}:${ip}`);
  res.json({ ok: true, message: `Cuota reseteada para ${ip}.` });
});

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
