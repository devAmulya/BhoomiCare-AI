// Global variables
let currentQueryData = null;

// DOM elements
const cropForm = document.getElementById('cropForm');
const submitBtn = document.getElementById('submitBtn');
const btnText = submitBtn.querySelector('.btn-text');
const btnLoader = submitBtn.querySelector('.btn-loader');
const welcomeSection = document.getElementById('welcomeSection');
const resultsSection = document.getElementById('resultsSection');
const newQueryBtn = document.getElementById('newQueryBtn');
const loadingOverlay = document.getElementById('loadingOverlay');

// Weather icons mapping
const weatherIcons = {
  '01d': '☀️', '01n': '🌙',
  '02d': '⛅', '02n': '☁️',
  '03d': '☁️', '03n': '☁️',
  '04d': '☁️', '04n': '☁️',
  '09d': '🌧️', '09n': '🌧️',
  '10d': '🌦️', '10n': '🌦️',
  '11d': '⛈️', '11n': '⛈️',
  '13d': '❄️', '13n': '❄️',
  '50d': '🌫️', '50n': '🌫️'
};

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
  initializeApp();
  setupEventListeners();
  loadDashboardStats();
});

function initializeApp() {
  // Set max date for sowing date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('sowingDate').max = today;
  
  // Add smooth scrolling
  document.documentElement.style.scrollBehavior = 'smooth';
}

function setupEventListeners() {
  // Form submission
  cropForm.addEventListener('submit', handleFormSubmit);
  
  // New query button
  newQueryBtn.addEventListener('click', showWelcomeSection);
  
  // Crop suggestions
  document.querySelectorAll('.suggestion-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById('cropName').value = this.dataset.crop;
      this.style.transform = 'scale(0.95)';
      setTimeout(() => {
        this.style.transform = '';
      }, 150);
    });
  });
  
  // Input animations
  document.querySelectorAll('input, select, textarea').forEach(input => {
    input.addEventListener('focus', function() {
      this.parentElement.style.transform = 'translateY(-2px)';
    });
    
    input.addEventListener('blur', function() {
      this.parentElement.style.transform = '';
    });
  });
}

async function handleFormSubmit(e) {
  e.preventDefault();
  
  const formData = new FormData(cropForm);
  const queryData = {
    cropName: formData.get('cropName').trim(),
    location: formData.get('location').trim(),
    sowingDate: formData.get('sowingDate') || null,
    cropStage: formData.get('cropStage') || null,
    observations: formData.get('observations') ? formData.get('observations').trim() : null
  };
  
  // Validation
  if (!queryData.cropName || !queryData.location) {
    showNotification('Please fill in all required fields', 'error');
    return;
  }
  
  currentQueryData = queryData;
  
  try {
    setLoadingState(true);
    showLoadingOverlay(true);
    
    // Submit query to backend
    const response = await fetch('/api/crop-query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(queryData)
    });
    
    if (!response.ok) {
      throw new Error('Failed to get recommendations');
    }
    
    const data = await response.json();
    
    // Display results
    displayResults(data);
    
    // Load additional data
    await Promise.all([
      loadPestAlerts(queryData.cropName),
      loadWeatherForecast(queryData.location)
    ]);
    
    showNotification('Recommendations loaded successfully!', 'success');
    
  } catch (error) {
    console.error('Error:', error);
    showNotification('Failed to get recommendations. Please try again.', 'error');
  } finally {
    setLoadingState(false);
    showLoadingOverlay(false);
  }
}

function displayResults(data) {
  const { weather, recommendations } = data;
  
  // Update results title
  document.getElementById('resultsTitle').textContent = 
    `${currentQueryData.cropName} Advisory Dashboard`;
  
  // Display weather data
  displayWeatherData(weather);
  
  // Display recommendations
  displayRecommendations(recommendations);
  
  // Show results section
  showResultsSection();
}

function displayWeatherData(weather) {
  document.getElementById('weatherLocation').textContent = currentQueryData.location;
  document.getElementById('temperature').textContent = Math.round(weather.temperature);
  document.getElementById('humidity').textContent = `${weather.humidity}%`;
  document.getElementById('windSpeed').textContent = `${Math.round(weather.windSpeed)} km/h`;
  document.getElementById('rainfall').textContent = `${weather.rainfall} mm`;
  document.getElementById('weatherDescription').textContent = weather.description;
  
  // Set weather icon
  const iconElement = document.getElementById('weatherIcon');
  iconElement.textContent = weatherIcons[weather.icon] || '🌤️';
}

function displayRecommendations(recommendations) {
  document.getElementById('irrigationAdvice').textContent = recommendations.irrigation;
  document.getElementById('cropCareAdvice').textContent = recommendations.cropCare;
  document.getElementById('weatherAlert').textContent = recommendations.weatherAlert;

  const healthCard = document.getElementById('healthCard');
  if (recommendations.healthAdvice) {
    document.getElementById('healthAdvice').textContent = recommendations.healthAdvice;
    healthCard.style.display = 'block';
  } else {
    healthCard.style.display = 'none';
  }
}

async function loadPestAlerts(cropName) {
  try {
    const response = await fetch(`/api/pest-alerts/${encodeURIComponent(cropName)}`);
    const pestData = await response.json();
    
    const pestContainer = document.getElementById('pestAlerts');
    
    if (pestData.length === 0) {
      pestContainer.innerHTML = '<p>No specific pest alerts for your crop at this time. Continue regular monitoring.</p>';
      return;
    }
    
    pestContainer.innerHTML = pestData.map(pest => `
      <div class="pest-alert">
        <div class="pest-name">${pest.pest_name}</div>
        <span class="pest-severity ${pest.severity.toLowerCase()}">${pest.severity} Risk</span>
        <div class="pest-description">${pest.description}</div>
        <div class="pest-prevention"><strong>Prevention:</strong> ${pest.prevention}</div>
      </div>
    `).join('');
    
  } catch (error) {
    console.error('Error loading pest alerts:', error);
    document.getElementById('pestAlerts').innerHTML = 
      '<p>Unable to load pest alerts. Please check your internet connection.</p>';
  }
}

async function loadWeatherForecast(location) {
  try {
    const response = await fetch(`/api/weather-forecast/${encodeURIComponent(location)}`);
    const forecastData = await response.json();
    
    const forecastContainer = document.getElementById('weatherForecast');
    
    forecastContainer.innerHTML = `
      <div class="forecast-grid">
        ${forecastData.forecast.map(day => `
          <div class="forecast-day">
            <div class="forecast-date">${formatDate(day.date)}</div>
            <div class="forecast-temp">${Math.round(day.temperature)}°C</div>
            <div class="forecast-desc">${day.description}</div>
          </div>
        `).join('')}
      </div>
    `;
    
  } catch (error) {
    console.error('Error loading weather forecast:', error);
    document.getElementById('weatherForecast').innerHTML = 
      '<p>Unable to load weather forecast. Please check your internet connection.</p>';
  }
}

async function loadDashboardStats() {
  try {
    const response = await fetch('/api/dashboard');
    const stats = await response.json();
    
    // Update total queries counter with animation
    animateCounter(document.getElementById('totalQueries'), stats.totalQueries || 0);
    
  } catch (error) {
    console.error('Error loading dashboard stats:', error);
  }
}

function animateCounter(element, target) {
  let current = 0;
  const increment = target / 50;
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) {
      current = target;
      clearInterval(timer);
    }
    element.textContent = Math.floor(current);
  }, 30);
}

function formatDate(dateString) {
  const date = new Date(dateString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  } else if (date.toDateString() === tomorrow.toDateString()) {
    return 'Tomorrow';
  } else {
    return date.toLocaleDateString('en-IN', { 
      weekday: 'short',
      day: 'numeric'
    });
  }
}

function showResultsSection() {
  welcomeSection.style.display = 'none';
  resultsSection.style.display = 'block';
  
  // Smooth scroll to results
  setTimeout(() => {
    resultsSection.scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

function showWelcomeSection() {
  resultsSection.style.display = 'none';
  welcomeSection.style.display = 'grid';
  
  // Reset form
  cropForm.reset();
  currentQueryData = null;
  
  // Smooth scroll to top
  setTimeout(() => {
    welcomeSection.scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

function setLoadingState(loading) {
  submitBtn.disabled = loading;
  
  if (loading) {
    btnText.style.display = 'none';
    btnLoader.style.display = 'flex';
  } else {
    btnText.style.display = 'block';
    btnLoader.style.display = 'none';
  }
}

function showLoadingOverlay(show) {
  loadingOverlay.style.display = show ? 'flex' : 'none';
}

function showNotification(message, type = 'info') {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.innerHTML = `
    <div class="notification-content">
      <span class="notification-icon">
        ${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}
      </span>
      <span class="notification-message">${message}</span>
    </div>
  `;
  
  // Add styles
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : '#3B82F6'};
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 1001;
    transform: translateX(100%);
    transition: transform 0.3s ease;
    max-width: 400px;
  `;
  
  notification.querySelector('.notification-content').style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
  `;
  
  // Add to DOM
  document.body.appendChild(notification);
  
  // Animate in
  setTimeout(() => {
    notification.style.transform = 'translateX(0)';
  }, 100);
  
  // Remove after delay
  setTimeout(() => {
    notification.style.transform = 'translateX(100%)';
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 300);
  }, 4000);
}

// Add some interactive animations
document.addEventListener('mousemove', function(e) {
  const cards = document.querySelectorAll('.result-card, .stat-item');
  
  cards.forEach(card => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = (y - centerY) / 10;
      const rotateY = (centerX - x) / 10;
      
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(10px)`;
    } else {
      card.style.transform = '';
    }
  });
});

// Add keyboard shortcuts
document.addEventListener('keydown', function(e) {
  // Ctrl/Cmd + Enter to submit form
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (welcomeSection.style.display !== 'none') {
      cropForm.dispatchEvent(new Event('submit'));
    }
  }
  
  // Escape to go back to welcome
  if (e.key === 'Escape' && resultsSection.style.display !== 'none') {
    showWelcomeSection();
  }
});

// Add service worker for offline functionality (optional)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js')
      .then(function(registration) {
        console.log('ServiceWorker registration successful');
      })
      .catch(function(err) {
        console.log('ServiceWorker registration failed');
      });
  });
}