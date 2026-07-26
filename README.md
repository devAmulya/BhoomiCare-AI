# 🌱 BhoomiCare AI

**Smart Farming for a Sustainable Future**

BhoomiCare AI is a web-based assistant that gives farmers personalized crop
care advice based on live weather data, crop type, growth stage, and soil
conditions.

## 🚀 Features

- 🌤️ **Live Weather** — current conditions for any location via OpenWeatherMap
- 📈 **5-Day Forecast** — real forecast data, aggregated to daily summaries
- 🧑‍🌾 **Personalized Advice** — irrigation, crop care, and weather-alert
  recommendations generated from crop type, growth stage, and current weather
- 🔍 **Observation-Based Health Advice** — free-text notes about your crop
  (e.g. "yellowing leaves", "pest signs") get matched to targeted advice
- 📸 **AI Crop Photo Analysis** — upload a photo and get the detected crop
  type, health status, and possible issues via Google Gemini's vision API
  (free tier, no cost to run) — results feed automatically into the
  observation-based advice above
- 🐛 **Pest Alerts** — seasonal pest/disease warnings from a seeded database,
  matched by crop and season
- 📊 **Query Dashboard** — tracks total queries and most-asked-about crops
- 📱 **Responsive Design** — works on phone, tablet, and desktop

## 🧭 Roadmap

Not built yet — listed here so it's clear what's real today vs. planned:

- 🌐 Multi-language UI (Hindi, Bengali, Tamil, Telugu, Marathi)
- 🔐 User accounts with saved query history

## 🛠️ Tech Stack

- **Backend:** Node.js, Express
- **Database:** SQLite (`sqlite3`)
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **External APIs:**
  - [OpenWeatherMap](https://openweathermap.org/api) — weather & forecast
  - [Google Gemini](https://aistudio.google.com/apikey) — crop photo analysis
    (free tier, no credit card required — chosen specifically so this project
    costs nothing to run)

> An earlier version of this project also included a Flask/Python backend.
> It's been removed to avoid maintaining two backends that had drifted out
> of sync — Node/Express is the one actually wired up to the frontend and
> database.

## 📦 Setup

**Requirements:** Node.js 18+, npm
- Free [OpenWeatherMap API key](https://openweathermap.org/api)
- Free [Gemini API key](https://aistudio.google.com/apikey) (no credit card — optional, only needed for photo analysis)

```bash
# 1. Clone and install
git clone <your-repo-url>
cd bhoomicare-ai
npm install

# 2. Configure environment
cp .env.example .env
# then edit .env and add your OPENWEATHER_API_KEY and GEMINI_API_KEY

# 3. Run
npm start        # production
npm run dev       # auto-reload with nodemon
```

The app runs at `http://localhost:3000` by default. A SQLite database
(`bhoomicare.db`) is created automatically on first run, seeded with sample
pest-alert data.

## 📁 Project Structure

```
bhoomicare-ai/
├── public/           # Static frontend
│   ├── index.html
│   ├── script.js
│   └── style.css
├── data/
│   └── pestData.json # Seed data for pest_alerts (15 crops, 35 entries)
├── server.js         # Express app + API routes
├── package.json
├── .env.example
└── bhoomicare.db     # created at runtime, not committed
```

## 🔌 API Endpoints

| Method | Route                              | Description                            |
|--------|-------------------------------------|-----------------------------------------|
| POST   | `/api/crop-query`                   | Submit crop query, get recommendations  |
| POST   | `/api/analyze-crop-image`           | Analyze a crop photo (Gemini vision)    |
| GET    | `/api/pest-alerts/:crop`            | Pest alerts for a crop/season           |
| GET    | `/api/weather-forecast/:location`   | Current weather + 5-day forecast        |
| GET    | `/api/dashboard`                    | Query stats (total, popular crops)      |

---

Made with ❤️ for Indian Farmers.
