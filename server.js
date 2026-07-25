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
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
      seedPestData();
    }
  });
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

// Seed pest data
function seedPestData() {
  const pestData = [
    {
      crop: 'Rice',
      pest: 'Brown Planthopper',
      severity: 'High',
      description: 'Small brown insects that suck plant juices, causing yellowing and stunted growth',
      prevention: 'Use resistant varieties, maintain proper water levels, apply neem oil spray',
      season: 'Monsoon'
    },
    {
      crop: 'Wheat',
      pest: 'Aphids',
      severity: 'Medium',
      description: 'Small green/black insects that cluster on leaves and stems',
      prevention: 'Regular monitoring, use ladybird beetles, spray with soapy water',
      season: 'Winter'
    },
    {
      crop: 'Cotton',
      pest: 'Bollworm',
      severity: 'High',
      description: 'Caterpillars that bore into cotton bolls, reducing yield significantly',
      prevention: 'Use pheromone traps, Bt cotton varieties, biological control agents',
      season: 'Summer'
    },
    {
      crop: 'Sugarcane',
      pest: 'Red Rot',
      severity: 'High',
      description: 'Fungal disease causing red discoloration and hollow stems',
      prevention: 'Use disease-free seeds, proper drainage, crop rotation',
      season: 'Monsoon'
    },
    {
      crop: 'Maize',
      pest: 'Fall Armyworm',
      severity: 'High',
      description: 'Caterpillars that feed on leaves, causing significant damage to young plants',
      prevention: 'Early detection, use of pheromone traps, biological pesticides',
      season: 'Monsoon'
    }
  ];

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

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Submit crop query
app.post('/api/crop-query', async (req, res) => {
  try {
    const { cropName, location, sowingDate, cropStage, observations } = req.body;

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

    // Store AI responses
    Object.entries(recommendations).forEach(([type, text]) => {
      db.run(
        'INSERT INTO ai_responses (query_id, response_type, response_text) VALUES (?, ?, ?)',
        [queryResult, type, text]
      );
    });

    res.json({
      success: true,
      queryId: queryResult,
      weather: weatherData,
      recommendations
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
    const prompt = `You are an agricultural crop health analyst. You will be shown a photo of a crop or plant. Respond with ONLY a JSON object in exactly this shape:
{"detectedCropType": string, "healthStatus": "Healthy" | "Unhealthy" | "Affected" | "Uncertain", "potentialIssues": string[], "notes": string}
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
          responseMimeType: 'application/json'
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const rawText = response.data.candidates[0].content.parts[0].text.trim();
    // responseMimeType: 'application/json' should already give clean JSON,
    // but strip markdown fences defensively in case the model wraps it anyway.
    const cleaned = rawText.replace(/^```json\s*|^```\s*|```$/g, '').trim();

    let analysis;
    try {
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse vision model response as JSON:', rawText);
      analysis = {
        detectedCropType: 'Unknown',
        healthStatus: 'Uncertain',
        potentialIssues: [],
        notes: 'Could not parse a structured result from the analysis. Raw response: ' + rawText.slice(0, 200)
      };
    }

    // Log the analysis (useful for the dashboard later, and for debugging model output)
    db.run(
      'INSERT INTO image_analyses (detected_crop, health_status, issues, notes) VALUES (?, ?, ?, ?)',
      [
        analysis.detectedCropType,
        analysis.healthStatus,
        JSON.stringify(analysis.potentialIssues || []),
        analysis.notes || null
      ]
    );

    res.json({
      detectedCropType: analysis.detectedCropType,
      healthStatus: analysis.healthStatus,
      potentialIssues: analysis.potentialIssues || [],
      notes: analysis.notes || ''
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
app.get('/api/pest-alerts/:crop', (req, res) => {
  const cropName = req.params.crop;
  const currentMonth = new Date().getMonth() + 1;
  let season = 'Summer';
  
  if (currentMonth >= 6 && currentMonth <= 9) season = 'Monsoon';
  else if (currentMonth >= 10 || currentMonth <= 2) season = 'Winter';

  db.all(
    'SELECT * FROM pest_alerts WHERE crop_name LIKE ? OR season = ? ORDER BY severity DESC',
    [`%${cropName}%`, season],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(rows);
      }
    }
  );
});

// Get weather forecast (real 5-day forecast from OpenWeatherMap's free forecast API)
app.get('/api/weather-forecast/:location', async (req, res) => {
  const location = req.params.location;

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

    const forecast = Object.keys(byDay).slice(0, 5).map(day => {
      const entries = byDay[day];
      // Prefer the reading closest to midday for a representative daily snapshot
      const midday = entries.reduce((best, e) => {
        const hour = parseInt(e.dt_txt.split(' ')[1].split(':')[0], 10);
        const bestHour = parseInt(best.dt_txt.split(' ')[1].split(':')[0], 10);
        return Math.abs(hour - 12) < Math.abs(bestHour - 12) ? e : best;
      });

      return {
        date: new Date(day).toLocaleDateString('en-IN'),
        temperature: midday.main.temp,
        humidity: midday.main.humidity,
        rainfall: midday.rain ? (midday.rain['3h'] || 0) : 0,
        description: midday.weather[0].description
      };
    });

    res.json({
      current: currentWeather,
      forecast
    });

  } catch (error) {
    console.error('Forecast API error:', error.message);
    // Fall back to a clearly-flagged estimate so the UI doesn't break without an API key
    const currentWeather = await getWeatherData(location);
    const forecast = [];
    for (let i = 0; i < 5; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      forecast.push({
        date: date.toLocaleDateString('en-IN'),
        temperature: currentWeather.temperature,
        humidity: currentWeather.humidity,
        rainfall: 0,
        description: currentWeather.description,
        estimated: true
      });
    }
    res.json({ current: currentWeather, forecast, note: 'Live forecast unavailable — showing current conditions as an estimate.' });
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