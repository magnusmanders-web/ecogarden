// EcoGarden Plant Monitor - Dashboard JavaScript

let currentDate = new Date().toISOString().split("T")[0];
let autoRefreshTimer = null;

// --- Initialization ---

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadThumbnails(currentDate);
  loadTimelapses();
  startAutoRefresh();
});

function startAutoRefresh() {
  // Refresh status every 60 seconds
  autoRefreshTimer = setInterval(() => {
    loadStatus();
  }, 60000);

  // Refresh photo every 5 minutes
  setInterval(() => {
    loadLatestPhoto();
  }, 300000);
}

// --- Data Loading ---

function loadStatus() {
  fetch("/api/status")
    .then((r) => r.json())
    .then((data) => {
      updateSensors(data.sensors);
      updateMqttStatus(data.mqtt_connected);
      updatePlantCards(data.plants);
      updateAlerts(data.alerts);
      updateAISummary(data);
      document.getElementById("last-update").textContent =
        "Updated " + new Date().toLocaleTimeString();
    })
    .catch((err) => console.error("Failed to load status:", err));

  loadLatestPhoto();
}

function loadLatestPhoto() {
  fetch("/api/photos/latest")
    .then((r) => r.json())
    .then((data) => {
      if (data.url) {
        const img = document.getElementById("latest-photo");
        img.src = data.url;
        img.style.display = "block";
        document.getElementById("photo-no-data").style.display = "none";
      }
    })
    .catch(() => {});
}

function loadThumbnails(dateStr) {
  fetch("/api/photos/" + dateStr)
    .then((r) => r.json())
    .then((photos) => {
      const strip = document.getElementById("thumbnail-strip");
      strip.innerHTML = "";

      photos.forEach((photo, i) => {
        const img = document.createElement("img");
        img.src = photo.url;
        img.alt = photo.time;
        img.title = photo.time;
        if (i === photos.length - 1) img.classList.add("active");
        img.onclick = () => {
          document.getElementById("latest-photo").src = photo.url;
          strip.querySelectorAll("img").forEach((t) => t.classList.remove("active"));
          img.classList.add("active");
        };
        strip.appendChild(img);
      });

      // Auto-scroll to end
      strip.scrollLeft = strip.scrollWidth;
    })
    .catch(() => {});
}

function loadTimelapses() {
  fetch("/api/timelapse")
    .then((r) => r.json())
    .then((data) => {
      const type = document.getElementById("timelapse-type").value;
      const select = document.getElementById("timelapse-select");
      const videos = data[type] || [];

      select.innerHTML = "";
      if (videos.length === 0) {
        select.innerHTML = '<option value="">No videos</option>';
        document.getElementById("timelapse-video").style.display = "none";
        document.getElementById("timelapse-no-data").style.display = "block";
        return;
      }

      videos.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v.replace(".mp4", "");
        select.appendChild(opt);
      });

      playTimelapse();
    })
    .catch(() => {});
}

function playTimelapse() {
  const type = document.getElementById("timelapse-type").value;
  const file = document.getElementById("timelapse-select").value;
  const video = document.getElementById("timelapse-video");
  const noData = document.getElementById("timelapse-no-data");

  if (!file) {
    video.style.display = "none";
    noData.style.display = "block";
    return;
  }

  video.src = "/timelapse/" + type + "/" + file;
  video.style.display = "block";
  noData.style.display = "none";
}

// --- UI Updates ---

function updateSensors(sensors) {
  const luxEl = document.getElementById("sensor-lux");
  const tempEl = document.getElementById("sensor-temp");

  luxEl.textContent = sensors.lux != null ? Math.round(sensors.lux) : "--";
  tempEl.textContent = sensors.temp_c != null ? sensors.temp_c.toFixed(1) : "--";
}

function updateMqttStatus(connected) {
  const badge = document.getElementById("mqtt-status");
  badge.className = "status-badge " + (connected ? "connected" : "disconnected");
}

function updateAlerts(alerts) {
  const container = document.getElementById("alerts-container");
  const list = document.getElementById("alerts-list");

  if (!alerts || alerts.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  list.innerHTML = alerts
    .map((a) => '<div class="alert-item">' + escapeHtml(a) + "</div>")
    .join("");
}

function updateAISummary(data) {
  const el = document.getElementById("ai-summary");
  if (!data.summary) {
    el.style.display = "none";
    return;
  }

  el.style.display = "flex";
  document.getElementById("ai-summary-text").textContent = data.summary;
  document.getElementById("ai-summary-date").textContent = data.analysis_date || "";

  const healthEl = document.getElementById("overall-health");
  if (data.overall_health != null) {
    healthEl.textContent = data.overall_health;
    healthEl.className = "sensor-value health-score health-" + data.overall_health;
  }
}

function updatePlantCards(plants) {
  const container = document.getElementById("plant-cards");
  container.innerHTML = "";

  plants.forEach((plant) => {
    const healthClass = getHealthClass(plant.health_score);
    const healthLabel = getHealthLabel(plant.health_score);
    const badgeClass = plant.health_score >= 4 ? "good" : plant.health_score === 3 ? "fair" : "poor";

    const card = document.createElement("div");
    card.className = "plant-card " + healthClass;
    card.innerHTML = `
      <div class="plant-card-header">
        <div>
          <div class="plant-name">${escapeHtml(plant.name)}</div>
          <div class="plant-species">${escapeHtml(plant.species)} &middot; ${plant.position}</div>
        </div>
        ${plant.health_score != null ? `<span class="health-badge ${badgeClass}">${plant.health_score}/5</span>` : ""}
      </div>
      <div class="plant-meta">
        <span>${plant.age_days} days old</span>
        <span>${capitalize(plant.growth_stage)}</span>
        ${plant.days_to_harvest != null ? `<span>Harvest: ~${plant.days_to_harvest}d</span>` : ""}
      </div>
      <div class="stage-bar">
        <div class="stage-bar-fill" style="width: ${plant.stage_progress}%"></div>
      </div>
      ${plant.observations ? `<div class="plant-observations">${escapeHtml(plant.observations)}</div>` : ""}
      ${plant.concerns ? `<div class="plant-concerns">${escapeHtml(plant.concerns)}</div>` : ""}
      <button class="plant-expand" onclick="toggleDetails(this)">Care guide & advice</button>
      <div class="plant-details">
        ${renderAdvice(plant.advice)}
        ${plant.harvest_tips ? `<div class="advice-item"><strong>Harvest:</strong> ${escapeHtml(plant.harvest_tips)}</div>` : ""}
      </div>
    `;
    container.appendChild(card);
  });
}

function renderAdvice(advice) {
  if (!advice || advice.length === 0) return "";
  return advice
    .map((a) => {
      const isWarning = a.toUpperCase().startsWith("WARNING");
      return `<div class="advice-item ${isWarning ? "warning" : ""}">${escapeHtml(a)}</div>`;
    })
    .join("");
}

// --- Actions ---

function manualCapture() {
  const btn = document.getElementById("capture-btn");
  btn.disabled = true;
  btn.textContent = "Capturing...";

  fetch("/capture", { method: "POST" })
    .then((r) => r.json())
    .then((data) => {
      btn.textContent = "Capture Now";
      btn.disabled = false;
      if (data.status === "ok") {
        loadLatestPhoto();
        loadThumbnails(currentDate);
      }
    })
    .catch(() => {
      btn.textContent = "Capture Now";
      btn.disabled = false;
    });
}

function toggleDetails(btn) {
  const details = btn.nextElementSibling;
  details.classList.toggle("open");
  btn.textContent = details.classList.contains("open") ? "Hide details" : "Care guide & advice";
}

function openFullscreen(img) {
  const overlay = document.getElementById("fullscreen-overlay");
  document.getElementById("fullscreen-img").src = img.src;
  overlay.classList.add("open");
}

function closeFullscreen() {
  document.getElementById("fullscreen-overlay").classList.remove("open");
}

// Close fullscreen with Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFullscreen();
});

// --- Helpers ---

function getHealthClass(score) {
  if (score == null) return "";
  if (score >= 4) return "health-4";
  if (score === 3) return "health-3";
  return "health-" + score;
}

function getHealthLabel(score) {
  if (score == null) return "No data";
  if (score >= 4) return "Healthy";
  if (score === 3) return "Fair";
  if (score === 2) return "Poor";
  return "Critical";
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
