# 🌱 BhoomiCare AI

**Smart farming assistant for Indian farmers** — personalized crop advice
powered by live weather data, AI-based photo analysis, and multi-language
support.

## Features

- **Live Weather & 5-Day Forecast** — real-time conditions and forecast via OpenWeatherMap
- **Personalized Advice** — irrigation, crop care, and weather-alert recommendations based on crop type, growth stage, and current weather
- **Observation-Based Health Advice** — free-text crop observations (e.g. "yellowing leaves") matched to targeted guidance
- **AI Crop Photo Analysis** — upload a photo for crop type, health status, and issue detection via Google Gemini's vision API
- **Pest & Disease Alerts** — seasonal warnings across 15 crops, matched by crop and season
- **Multi-Language UI** — English, Hindi, Bengali, Tamil, Telugu, and Marathi, including translated AI-generated advice
- **Query Dashboard** — tracks usage and popular crops
- **Responsive Design** — phone, tablet, and desktop

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Database | SQLite |
| Frontend | HTML, CSS, JavaScript (no framework) |
| Weather | [OpenWeatherMap API](https://openweathermap.org/api) |
| AI / Vision / Translation | [Google Gemini API](https://aistudio.google.com/apikey) (free tier) |

## Live Demo

_[Add your deployed URL here]_

## Getting Started

**Requirements:** Node.js 18+, npm

```bash
git clone <your-repo-url>
cd bhoomicare-ai
npm install
cp .env.example .env   # add your API keys
npm start
```

The app runs at `http://localhost:3000`. The SQLite database is created
and seeded automatically on first run.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENWEATHER_API_KEY` | Yes | [Free key](https://openweathermap.org/api) for weather/forecast |
| `GEMINI_API_KEY` | Optional | [Free key](https://aistudio.google.com/apikey) for photo analysis & translation |
| `PORT` | No | Defaults to 3000 |

## Deployment

Deployed on [Render](https://render.com) (free tier):

1. Connect the GitHub repo as a new Web Service
2. Build command: `npm install` · Start command: `npm start`
3. Add `OPENWEATHER_API_KEY` and `GEMINI_API_KEY` as environment variables

## Project Structure

```
bhoomicare-ai/
├── public/           # Frontend
│   ├── index.html
│   ├── script.js
│   ├── style.css
│   ├── i18n.js        # Language switching logic
│   └── i18n/           # Translation dictionaries (en, hi, bn, ta, te, mr)
├── data/
│   └── pestData.json  # Pest/disease seed data (15 crops)
├── server.js           # Express app + API routes
├── package.json
└── .env.example
```

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/crop-query` | Submit a crop query, receive personalized recommendations |
| `POST` | `/api/analyze-crop-image` | Analyze a crop photo for health/issues |
| `GET` | `/api/pest-alerts/:crop` | Pest alerts for a crop, filtered by season |
| `GET` | `/api/weather-forecast/:location` | Current weather + 5-day forecast |
| `GET` | `/api/dashboard` | Usage statistics |

## Notes

- Machine-translated content (advice text, pest alerts) is AI-generated;
  a native-speaker review is recommended before production use.
- On free-tier hosting, the SQLite database resets on redeploy — pest
  data reseeds automatically, but query history is not persisted long-term.

## License

MIT

---

Built for Indian farmers.
