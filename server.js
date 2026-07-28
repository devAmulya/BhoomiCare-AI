const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Extensions mapped to the MIME types Gemini's vision API actually accepts.
// Needed because some browsers/OSes send a generic mimetype (often
// application/octet-stream) for certain image files — .jfif being the most
// common culprit — even though the file is a perfectly normal JPEG.
const IMAGE_EXTENSION_MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
};

function resolveImageMimeType(file) {
  if (file.mimetype && file.mimetype.startsWith('image/') && file.mimetype !== 'application/octet-stream') {
    return file.mimetype;
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  return IMAGE_EXTENSION_MIME_MAP[ext] || null;
}

// In-memory storage — we only need the buffer long enough to send it to the
// vision API, no need to persist uploaded photos to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const looksLikeImage = (file.mimetype && file.mimetype.startsWith('image/')) ||
      IMAGE_EXTENSION_MIME_MAP[path.extname(file.originalname || '').toLowerCase()];
    if (looksLikeImage) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite Database
const db = new sqlite3.Database('./bhoomicare.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Create tables
function initializeDatabase() {
  const createTables = `
    CREATE TABLE IF NOT EXISTS user_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_name TEXT NOT NULL,
      location TEXT NOT NULL,
      sowing_date TEXT,
      crop_stage TEXT,
      observations TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS weather_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      temperature REAL,
      humidity INTEGER,
      rainfall REAL,
      wind_speed REAL,
      weather_description TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id INTEGER,
      response_type TEXT,
      response_text TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (query_id) REFERENCES user_queries (id)
    );

    CREATE TABLE IF NOT EXISTS pest_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_name TEXT NOT NULL,
      pest_name TEXT NOT NULL,
      severity TEXT,
      description TEXT,
      prevention TEXT,
      season TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(crop_name, pest_name)
    );

    CREATE TABLE IF NOT EXISTS image_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_crop TEXT,
      health_status TEXT,
      issues TEXT,
      notes TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;

  db.exec(createTables, (err) => {
    if (err) {
      console.error('Error creating tables:', err.message);
    } else {
      console.log('Database tables initialized');
      migrateSchema();
      deduplicatePestAlerts();
    }
  });
}

// Fixes a real bug: INSERT OR IGNORE in seedPestData() had no UNIQUE
// constraint to check against, so every server restart (nodemon restarts
// constantly during development) re-inserted all pest_alerts rows on top
// of the existing ones. This removes any duplicates that already
// accumulated, then adds the unique index so it can't happen again before
// re-seeding (seeding now runs after this, so freshly-deduplicated data
// won't get re-duplicated by the seed step itself).
function deduplicatePestAlerts() {
  db.run(
    `DELETE FROM pest_alerts
     WHERE id NOT IN (
       SELECT MIN(id) FROM pest_alerts GROUP BY crop_name, pest_name
     )`,
    function (err) {
      if (err) {
        console.error('Failed to deduplicate pest_alerts:', err.message);
        seedPestData();
        return;
      }
      if (this.changes > 0) {
        console.log(`Removed ${this.changes} duplicate pest_alerts row(s)`);
      }
      db.run(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_pest_alerts_unique ON pest_alerts(crop_name, pest_name)',
        (idxErr) => {
          if (idxErr) console.error('Failed to create unique index on pest_alerts:', idxErr.message);
          seedPestData();
        }
      );
    }
  );
}

// Migrate existing databases created before the `observations` column existed.
// CREATE TABLE IF NOT EXISTS only applies to brand-new tables, so older
// bhoomicare.db files need an explicit ALTER TABLE.
function migrateSchema() {
  db.all("PRAGMA table_info(user_queries)", (err, columns) => {
    if (err) {
      console.error('Migration check failed:', err.message);
      return;
    }
    const hasObservations = columns.some(col => col.name === 'observations');
    if (!hasObservations) {
      db.run('ALTER TABLE user_queries ADD COLUMN observations TEXT', (alterErr) => {
        if (alterErr) {
          console.error('Migration error:', alterErr.message);
        } else {
          console.log('Migrated: added observations column to user_queries');
        }
      });
    }
  });
}

// Seed pest data — loaded from data/pestData.json so it's easy to expand
// without touching application logic.
function seedPestData() {
  const pestData = require('./data/pestData.json');

  const insertPest = db.prepare(`
    INSERT OR IGNORE INTO pest_alerts (crop_name, pest_name, severity, description, prevention, season)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  pestData.forEach(pest => {
    insertPest.run(pest.crop, pest.pest, pest.severity, pest.description, pest.prevention, pest.season);
  });

  insertPest.finalize();
}

// Weather API integration
// OpenWeatherMap uses a fixed, documented vocabulary of condition
// descriptions. A static dictionary for the common ones is faster and more
// reliable than an API call every time; translateWeatherDescription() falls
// back to the same Gemini helper only for the rare description not covered
// here (e.g. "volcanic ash", "tornado").
const WEATHER_DESCRIPTIONS = {
  'clear sky': { hi: 'साफ आसमान', bn: 'পরিষ্কার আকাশ', ta: 'தெளிவான வானம்', te: 'నిర్మలమైన ఆకాశం', mr: 'निरभ्र आकाश' },
  'few clouds': { hi: 'कुछ बादल', bn: 'কিছু মেঘ', ta: 'சில மேகங்கள்', te: 'కొన్ని మేఘాలు', mr: 'काही ढग' },
  'scattered clouds': { hi: 'बिखरे हुए बादल', bn: 'বিক্ষিপ্ত মেঘ', ta: 'சிதறிய மேகங்கள்', te: 'చెదురుమదురు మేఘాలు', mr: 'विखुरलेले ढग' },
  'broken clouds': { hi: 'टूटे हुए बादल', bn: 'ভাঙা মেঘ', ta: 'உடைந்த மேகங்கள்', te: 'విరిగిన మేఘాలు', mr: 'तुटलेले ढग' },
  'overcast clouds': { hi: 'घने बादल', bn: 'মেঘলা আকাশ', ta: 'மேகமூட்டமான வானம்', te: 'మేఘావృత ఆకాశం', mr: 'ढगाळ आकाश' },
  'light rain': { hi: 'हल्की बारिश', bn: 'হালকা বৃষ্টি', ta: 'லேசான மழை', te: 'తేలికపాటి వర్షం', mr: 'हलका पाऊस' },
  'moderate rain': { hi: 'मध्यम बारिश', bn: 'মাঝারি বৃষ্টি', ta: 'மிதமான மழை', te: 'మోస్తరు వర్షం', mr: 'मध्यम पाऊस' },
  'heavy intensity rain': { hi: 'तेज़ बारिश', bn: 'ভারী বৃষ্টি', ta: 'கனமழை', te: 'భారీ వర్షం', mr: 'जोरदार पाऊस' },
  'very heavy rain': { hi: 'बहुत तेज़ बारिश', bn: 'অতি ভারী বৃষ্টি', ta: 'மிக கனமழை', te: 'అతి భారీ వర్షం', mr: 'अतिजोरदार पाऊस' },
  'light intensity shower rain': { hi: 'हल्की बौछार', bn: 'হালকা পশলা', ta: 'லேசான அபுஷி மழை', te: 'తేలికపాటి జల్లులు', mr: 'हलकी सर' },
  'shower rain': { hi: 'बौछार', bn: 'পশলা বৃষ্টি', ta: 'அபுஷி மழை', te: 'జల్లులు', mr: 'सरी' },
  'thunderstorm': { hi: 'आंधी-तूफान', bn: 'বজ্রঝড়', ta: 'இடிமின்னலுடன் புயல்', te: 'ఉరుములతో కూడిన తుఫాను', mr: 'वादळ' },
  'light snow': { hi: 'हल्की बर्फबारी', bn: 'হালকা তুষারপাত', ta: 'லேசான பனிப்பொழிவு', te: 'తేలికపాటి మంచు', mr: 'हलकी बर्फवृष्टी' },
  'snow': { hi: 'बर्फबारी', bn: 'তুষারপাত', ta: 'பனிப்பொழிவு', te: 'మంచు', mr: 'बर्फवृष्टी' },
  'mist': { hi: 'धुंध', bn: 'কুয়াশা', ta: 'மூடுபனி', te: 'పొగమంచు', mr: 'धुके' },
  'fog': { hi: 'कोहरा', bn: 'কুয়াশা', ta: 'பனிமூட்டம்', te: 'పొగమంచు', mr: 'धुके' },
  'haze': { hi: 'धुंधलापन', bn: 'অস্পষ্টতা', ta: 'மங்கலான வானம்', te: 'పొగమంచు వాతావరణం', mr: 'धूसर वातावरण' },
  'smoke': { hi: 'धुआं', bn: 'ধোঁয়া', ta: 'புகை', te: 'పొగ', mr: 'धूर' },
  'drizzle': { hi: 'बूंदाबांदी', bn: 'গুঁড়ি গুঁড়ি বৃষ্টি', ta: 'தூறல்', te: 'తుంపర్లు', mr: 'रिमझिम पाऊस' }
};

async function translateWeatherDescription(description, langCode) {
  if (!description || !TRANSLATABLE_LANGUAGES[langCode]) return description;
  const key = description.toLowerCase();
  if (WEATHER_DESCRIPTIONS[key] && WEATHER_DESCRIPTIONS[key][langCode]) {
    return WEATHER_DESCRIPTIONS[key][langCode];
  }
  // Rare/uncommon description not in the static list — fall back to Gemini
  // for just this one short phrase rather than leaving it in English.
  const result = await translateFields({ description }, langCode);
  return result.description;
}

async function getWeatherData(location) {
  try {
    const API_KEY = process.env.OPENWEATHER_API_KEY || 'demo_key';
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${location}&appid=${API_KEY}&units=metric`
    );
    
    return {
      temperature: response.data.main.temp,
      humidity: response.data.main.humidity,
      rainfall: response.data.rain ? response.data.rain['1h'] || 0 : 0,
      // OpenWeatherMap returns wind speed in m/s under units=metric.
      // Convert to km/h since that's what the UI displays and the alert thresholds assume.
      windSpeed: response.data.wind.speed * 3.6,
      description: response.data.weather[0].description,
      icon: response.data.weather[0].icon
    };
  } catch (error) {
    console.error('Weather API error:', error.message);
    // Return mock data if API fails
    return {
      temperature: 28,
      humidity: 65,
      rainfall: 0,
      windSpeed: 8,
      description: 'partly cloudy',
      icon: '02d'
    };
  }
}

// Ported from the old Flask /api/advice route: turns free-text farmer
// observations ("yellowing leaves", "pest signs", etc.) into targeted advice.
// Returns null when there's nothing useful to say, so callers can skip
// showing a health card rather than displaying empty/generic filler.
function getObservationAdvice(observations) {
  if (!observations || !observations.trim()) {
    return null;
  }

  const text = observations.toLowerCase();

  if (text.includes('yellowing leaves') || text.includes('nutrient deficiency')) {
    return '🟡 Signs point to nutrient deficiency (likely nitrogen or iron) or overwatering. Consider a balanced fertilizer application and check drainage.';
  }
  if (text.includes('new shoots') || text.includes('vigorous growth')) {
    return '🌱 Vigorous growth detected — continue regular care, ensure adequate sunlight and nutrients, and keep an eye out for early pest activity.';
  }
  if (text.includes('pest signs') || text.includes('pest infestation')) {
    return '🐛 Pest activity noted — inspect closely for common culprits (aphids, armyworms) and apply appropriate organic pest control promptly.';
  }
  if (text.includes('healthy growth')) {
    return '✅ Your crop appears healthy — continue current practices and focus on preventative measures for common regional issues.';
  }

  // Any other observation text still gets a response, just a more general one
  return '🔍 Based on your notes: maintain moderate irrigation and monitor for fungal growth if humidity is high. Consider organic fertilizer every two weeks.';
}

// AI-powered recommendations (simulated)
function generateAIRecommendations(cropData, weatherData, observations) {
  const { cropName, location, sowingDate, cropStage } = cropData;
  const { temperature, humidity, rainfall, windSpeed, description } = weatherData;

  // Irrigation advice
  let irrigationAdvice = '';
  if (rainfall > 5) {
    irrigationAdvice = `🌧️ Recent rainfall detected (${rainfall}mm). Skip irrigation for 2-3 days. Monitor soil moisture levels.`;
  } else if (humidity < 40) {
    irrigationAdvice = `💧 Low humidity (${humidity}%). Increase irrigation frequency. Water early morning or evening.`;
  } else if (temperature > 35) {
    irrigationAdvice = `🌡️ High temperature (${temperature}°C). Provide adequate water and consider mulching to retain moisture.`;
  } else {
    irrigationAdvice = `💧 Normal irrigation schedule recommended. Water every 2-3 days based on soil moisture.`;
  }

  // Crop care advice
  let cropCareAdvice = '';
  const currentMonth = new Date().getMonth() + 1;
  
  if (cropName.toLowerCase().includes('rice')) {
    if (currentMonth >= 6 && currentMonth <= 9) {
      cropCareAdvice = `🌾 Monsoon season for rice. Ensure proper drainage to prevent waterlogging. Watch for blast disease.`;
    } else {
      cropCareAdvice = `🌾 Maintain water levels at 2-3 inches. Apply nitrogen fertilizer in split doses.`;
    }
  } else if (cropName.toLowerCase().includes('wheat')) {
    if (currentMonth >= 11 || currentMonth <= 3) {
      cropCareAdvice = `🌾 Optimal wheat growing season. Apply phosphorus at sowing and nitrogen in 2-3 splits.`;
    } else {
      cropCareAdvice = `🌾 Off-season for wheat. Consider summer crops like maize or cotton.`;
    }
  } else {
    cropCareAdvice = `🌾 Monitor crop regularly for pests and diseases. Apply balanced fertilizer as per soil test.`;
  }

  // Weather-based alerts
  let weatherAlert = '';
  if (windSpeed > 15) {
    weatherAlert = `⚠️ High wind speed (${windSpeed} km/h). Provide support to tall crops and check for physical damage.`;
  } else if (temperature < 10) {
    weatherAlert = `❄️ Low temperature alert. Protect sensitive crops from cold damage.`;
  } else if (humidity > 80 && temperature > 25) {
    weatherAlert = `🦠 High humidity and temperature favor fungal diseases. Apply preventive fungicide spray.`;
  }

  const healthAdvice = getObservationAdvice(observations);

  return {
    irrigation: irrigationAdvice,
    cropCare: cropCareAdvice,
    weatherAlert: weatherAlert || '✅ Weather conditions are favorable for crop growth.',
    ...(healthAdvice ? { healthAdvice } : {})
  };
}

// Extracts the first complete, balanced top-level JSON object from a string,
// tolerating any trailing content after it. Needed because Gemini 3.x models
// have "thinking" on by default, and reasoning text can end up appended
// after the actual JSON answer even with responseMimeType: 'application/json'.
// A plain JSON.parse() would fail on that trailing content with "Unexpected
// non-whitespace character after JSON".
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced/truncated — caller should fall back
}

// Language codes supported by the UI that also need advice-text translation.
// 'en' is intentionally excluded — no translation call needed for English.
const TRANSLATABLE_LANGUAGES = {
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi'
};

// Translates an object of English text fields into the target language using
// the same free-tier Gemini setup as the crop photo analysis (MR4). Used for
// advice text and pest alert text, since that content is generated/stored in
// English and combinatorial (crop x weather x observations), making static
// dictionaries impractical the way they work for fixed UI labels.
//
// On any failure (no API key, rate limit, parse error) this falls back to
// returning the original English fields unchanged rather than breaking the
// request — a farmer seeing English advice is a much better failure mode
// than a broken page.
async function translateFields(fields, langCode) {
  const languageName = TRANSLATABLE_LANGUAGES[langCode];
  if (!languageName) return fields; // 'en' or unrecognized — no-op

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    console.warn('Skipping advice translation: GEMINI_API_KEY not configured.');
    return fields;
  }

  try {
    const prompt = `Translate the values in this JSON object into ${languageName}. Keep the exact same JSON keys. Preserve all emojis, numbers, percentages, and units (like °C, km/h, mm) exactly as they appear. Return ONLY the translated JSON object, no other text.

${JSON.stringify(fields)}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          // This is a simple translation task with no reasoning needed —
          // keep thinking minimal to reduce latency/quota use and avoid
          // reasoning text leaking into the response (see extractFirstJsonObject).
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: false }
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const rawText = response.data.candidates[0].content.parts[0].text.trim();
    const jsonSlice = extractFirstJsonObject(rawText);
    if (!jsonSlice) throw new Error('No JSON object found in translation response');
    const translated = JSON.parse(jsonSlice);

    // Only accept keys we actually asked for, and fall back per-field if
    // the model dropped one, rather than discarding the whole translation.
    const result = {};
    Object.keys(fields).forEach(key => {
      result[key] = (translated[key] && typeof translated[key] === 'string') ? translated[key] : fields[key];
    });
    return result;

  } catch (error) {
    console.error('Advice translation failed, falling back to English:', error.message);
    return fields;
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Submit crop query
app.post('/api/crop-query', async (req, res) => {
  try {
    const { cropName, location, sowingDate, cropStage, observations, language } = req.body;

    // Insert user query
    const queryResult = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO user_queries (crop_name, location, sowing_date, crop_stage, observations) VALUES (?, ?, ?, ?, ?)',
        [cropName, location, sowingDate, cropStage, observations || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Get weather data
    const weatherData = await getWeatherData(location);

    // Store weather data
    db.run(
      'INSERT INTO weather_data (location, temperature, humidity, rainfall, wind_speed, weather_description) VALUES (?, ?, ?, ?, ?, ?)',
      [location, weatherData.temperature, weatherData.humidity, weatherData.rainfall, weatherData.windSpeed, weatherData.description]
    );

    // Generate AI recommendations
    const recommendations = generateAIRecommendations(
      { cropName, location, sowingDate, cropStage },
      weatherData,
      observations
    );

    // Store AI responses (always in English, so the DB/dashboard stays
    // consistent regardless of what language any given user picked)
    Object.entries(recommendations).forEach(([type, text]) => {
      db.run(
        'INSERT INTO ai_responses (query_id, response_type, response_text) VALUES (?, ?, ?)',
        [queryResult, type, text]
      );
    });

    // Translate a copy for the response only — falls back to English
    // automatically if translation fails for any reason (see translateFields)
    const localizedRecommendations = await translateFields(recommendations, language);
    const localizedWeather = {
      ...weatherData,
      description: await translateWeatherDescription(weatherData.description, language)
    };

    res.json({
      success: true,
      queryId: queryResult,
      weather: localizedWeather,
      recommendations: localizedRecommendations
    });

  } catch (error) {
    console.error('Error processing crop query:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Analyze a crop photo using Google Gemini's vision API (free tier — no
// billing required, see https://aistudio.google.com/apikey).
// This replaces the old Flask placeholder, which faked results by checking
// for words like "sick" in the uploaded filename.
app.post('/api/analyze-crop-image', upload.single('crop_image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured on the server. Add it to your .env file (free key at https://aistudio.google.com/apikey).'
    });
  }

  const mimeType = resolveImageMimeType(req.file);
  if (!mimeType) {
    return res.status(400).json({ error: 'Unrecognized image format. Try JPEG, PNG, WebP, or HEIC.' });
  }

  try {
    const base64Image = req.file.buffer.toString('base64');
    const language = req.body.language;
    const languageName = TRANSLATABLE_LANGUAGES[language];

    // One call, two outputs: ask for English (needed internally — the
    // frontend keyword-matches on English words like "healthy"/"pest" to
    // feed the observations field, and English is what we store in the DB)
    // AND the translated version for display, instead of doing a separate
    // translation call after the fact.
    const shape = '{"detectedCropType": string, "healthStatus": "Healthy" | "Unhealthy" | "Affected" | "Uncertain", "potentialIssues": string[], "notes": string}';
    const prompt = languageName
      ? `You are an agricultural crop health analyst. You will be shown a photo of a crop or plant. Respond with ONLY a JSON object in exactly this shape:
{"en": ${shape}, "translated": ${shape}}
"en" must be in English. "translated" must be the same analysis translated into ${languageName}, with "healthStatus" translated too (still one of the four categories, just in ${languageName}). Keep each entry in potentialIssues short (2-4 words, e.g. "Aphid Infestation" / its ${languageName} translation). Use an empty array if you see no issues. If the image doesn't clearly show a crop/plant, or you can't confidently identify it, set detectedCropType to "Unknown" (and its translation) and explain briefly in notes.`
      : `You are an agricultural crop health analyst. You will be shown a photo of a crop or plant. Respond with ONLY a JSON object in exactly this shape:
${shape}
Keep each entry in potentialIssues short (2-4 words, e.g. "Aphid Infestation", "Nutrient Deficiency"). Use an empty array if you see no issues. If the image doesn't clearly show a crop/plant, or you can't confidently identify it, set detectedCropType to "Unknown" and explain briefly in notes.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          // Keep some thinking for actual image analysis (unlike the pure
          // translation call above) but cap it low — this is a simple
          // classification task, not deep reasoning — and hide thought
          // content from the response so it can't leak into the JSON parse.
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: false }
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const rawText = response.data.candidates[0].content.parts[0].text.trim();
    // Prefer extracting a balanced JSON object over a naive fence-strip —
    // tolerates any stray text (e.g. leftover reasoning) around the JSON.
    const jsonSlice = extractFirstJsonObject(rawText);

    const fallback = {
      detectedCropType: 'Unknown',
      healthStatus: 'Uncertain',
      potentialIssues: [],
      notes: 'Could not parse a structured result from the analysis. Raw response: ' + rawText.slice(0, 200)
    };

    let englishAnalysis;
    let displayAnalysis;
    try {
      if (!jsonSlice) throw new Error('No JSON object found in response');
      const parsed = JSON.parse(jsonSlice);
      if (languageName) {
        englishAnalysis = parsed.en || fallback;
        displayAnalysis = parsed.translated || englishAnalysis;
      } else {
        englishAnalysis = parsed;
        displayAnalysis = parsed;
      }
    } catch (parseErr) {
      console.error('Failed to parse vision model response as JSON:', rawText);
      englishAnalysis = fallback;
      displayAnalysis = fallback;
    }

    // Log the English version (useful for the dashboard later, and keeps
    // stored data consistent regardless of what language any user picked)
    db.run(
      'INSERT INTO image_analyses (detected_crop, health_status, issues, notes) VALUES (?, ?, ?, ?)',
      [
        englishAnalysis.detectedCropType,
        englishAnalysis.healthStatus,
        JSON.stringify(englishAnalysis.potentialIssues || []),
        englishAnalysis.notes || null
      ]
    );

    res.json({
      detectedCropType: displayAnalysis.detectedCropType,
      healthStatus: displayAnalysis.healthStatus,
      potentialIssues: displayAnalysis.potentialIssues || [],
      notes: displayAnalysis.notes || '',
      // English versions, kept alongside the display versions so the
      // frontend's keyword-matching (mapAnalysisToObservationText in
      // script.js) keeps working regardless of UI language.
      detectedCropTypeEn: englishAnalysis.detectedCropType,
      healthStatusEn: englishAnalysis.healthStatus,
      potentialIssuesEn: englishAnalysis.potentialIssues || []
    });

  } catch (error) {
    if (error.response) {
      console.error('Vision API error:', error.response.status, JSON.stringify(error.response.data));
      const apiMessage = error.response.data && error.response.data.error && error.response.data.error.message;
      if (error.response.status === 400 && apiMessage && apiMessage.toLowerCase().includes('api key')) {
        return res.status(500).json({ error: 'Invalid GEMINI_API_KEY.' });
      }
      if (error.response.status === 429) {
        return res.status(429).json({ error: 'Rate limited by the free Gemini tier. Please try again shortly.' });
      }
    } else {
      console.error('Vision API error:', error.message);
    }
    res.status(500).json({ error: 'Failed to analyze image.' });
  }
});

// Get pest alerts for specific crop
app.get('/api/pest-alerts/:crop', async (req, res) => {
  const cropName = req.params.crop;
  const language = req.query.lang;
  const currentMonth = new Date().getMonth() + 1;
  let season = 'Summer';
  
  if (currentMonth >= 6 && currentMonth <= 9) season = 'Monsoon';
  else if (currentMonth >= 10 || currentMonth <= 2) season = 'Winter';

  db.all(
    `SELECT * FROM pest_alerts
     WHERE crop_name LIKE ?
     ORDER BY
       CASE WHEN season = ? THEN 0 ELSE 1 END,
       CASE severity WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END`,
    [`%${cropName}%`, season],
    async (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!language || language === 'en' || rows.length === 0) {
        return res.json(rows);
      }

      try {
        // Batch every row's translatable text into a single Gemini call
        // (one request for the whole list, not one per pest). `severity`
        // is deliberately excluded — the frontend uses it as a CSS class
        // name (e.g. .toLowerCase() === 'high'), so translating it would
        // break the styling.
        const fieldsToTranslate = {};
        rows.forEach((row, i) => {
          fieldsToTranslate[`pest_name_${i}`] = row.pest_name;
          fieldsToTranslate[`description_${i}`] = row.description;
          fieldsToTranslate[`prevention_${i}`] = row.prevention;
        });

        const translated = await translateFields(fieldsToTranslate, language);

        const localizedRows = rows.map((row, i) => ({
          ...row,
          pest_name: translated[`pest_name_${i}`] || row.pest_name,
          description: translated[`description_${i}`] || row.description,
          prevention: translated[`prevention_${i}`] || row.prevention
        }));

        res.json(localizedRows);
      } catch (translateErr) {
        console.error('Pest alert translation failed, returning English:', translateErr.message);
        res.json(rows);
      }
    }
  );
});

// Get weather forecast (real 5-day forecast from OpenWeatherMap's free forecast API)
app.get('/api/weather-forecast/:location', async (req, res) => {
  const location = req.params.location;
  const language = req.query.lang;

  try {
    const API_KEY = process.env.OPENWEATHER_API_KEY;
    if (!API_KEY) {
      throw new Error('OPENWEATHER_API_KEY not configured');
    }

    const currentWeather = await getWeatherData(location);

    // Free-tier OpenWeatherMap only offers a 5-day / 3-hour-step forecast,
    // not a true 7-day forecast, so we aggregate that into 5 daily summaries.
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(location)}&appid=${API_KEY}&units=metric`
    );

    const byDay = {};
    response.data.list.forEach(entry => {
      const day = entry.dt_txt.split(' ')[0]; // "YYYY-MM-DD"
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(entry);
    });

    const forecastDays = Object.keys(byDay).slice(0, 5).map(day => {
      const entries = byDay[day];
      // Prefer the reading closest to midday for a representative daily snapshot
      const midday = entries.reduce((best, e) => {
        const hour = parseInt(e.dt_txt.split(' ')[1].split(':')[0], 10);
        const bestHour = parseInt(best.dt_txt.split(' ')[1].split(':')[0], 10);
        return Math.abs(hour - 12) < Math.abs(bestHour - 12) ? e : best;
      });

      return {
        date: day, // raw ISO "YYYY-MM-DD" — frontend formats this per locale
        temperature: midday.main.temp,
        humidity: midday.main.humidity,
        rainfall: midday.rain ? (midday.rain['3h'] || 0) : 0,
        description: midday.weather[0].description
      };
    });

    // Translate current + each forecast day's description. Each uses the
    // static dictionary when possible (no extra API call), only falling
    // back to Gemini for uncommon phrases not in that list.
    const localizedCurrent = {
      ...currentWeather,
      description: await translateWeatherDescription(currentWeather.description, language)
    };
    const localizedForecast = await Promise.all(
      forecastDays.map(async (day) => ({
        ...day,
        description: await translateWeatherDescription(day.description, language)
      }))
    );

    res.json({
      current: localizedCurrent,
      forecast: localizedForecast
    });

  } catch (error) {
    console.error('Forecast API error:', error.message);
    // Fall back to a clearly-flagged estimate so the UI doesn't break without an API key
    const currentWeather = await getWeatherData(location);
    const translatedDescription = await translateWeatherDescription(currentWeather.description, language);
    const forecast = [];
    for (let i = 0; i < 5; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      forecast.push({
        date: date.toISOString().split('T')[0], // raw ISO, same as above
        temperature: currentWeather.temperature,
        humidity: currentWeather.humidity,
        rainfall: 0,
        description: translatedDescription,
        estimated: true
      });
    }
    res.json({
      current: { ...currentWeather, description: translatedDescription },
      forecast,
      note: 'Live forecast unavailable — showing current conditions as an estimate.'
    });
  }
});

// Get dashboard analytics
app.get('/api/dashboard', (req, res) => {
  const queries = {
    totalQueries: 'SELECT COUNT(*) as count FROM user_queries',
    popularCrops: 'SELECT crop_name, COUNT(*) as count FROM user_queries GROUP BY crop_name ORDER BY count DESC LIMIT 5',
    recentQueries: 'SELECT * FROM user_queries ORDER BY timestamp DESC LIMIT 10'
  };

  const results = {};
  let completed = 0;

  Object.entries(queries).forEach(([key, query]) => {
    db.all(query, (err, rows) => {
      if (!err) {
        results[key] = key === 'totalQueries' ? rows[0].count : rows;
      }
      completed++;
      
      if (completed === Object.keys(queries).length) {
        res.json(results);
      }
    });
  });
});

// Error handling
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Image file is too large (10MB max).' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🌾 BhoomiCare AI server running on port ${PORT}`);
  console.log(`📱 Access the app at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(0);
  });
});