// EcoGarden Plant Monitor

let currentDate = new Date().toISOString().split("T")[0];

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadThumbnails(currentDate);
  loadTimelapses();
  loadLightState();

  setInterval(loadStatus, 60000);
  setInterval(loadLatestPhoto, 300000);
});

// --- Data ---

function loadStatus() {
  fetch("/api/status")
    .then((r) => r.json())
    .then((data) => {
      updateSensors(data.sensors);
      updateMqttStatus(data.mqtt_connected);
      updatePlantCards(data.plants);
      updateAlerts(data.alerts);
      updateAISummary(data);
    })
    .catch(() => {});

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

        const timeEl = document.getElementById("photo-time");
        const parts = data.filename.replace(".jpg", "").split("_");
        if (parts.length >= 2) {
          timeEl.textContent = parts.slice(1).join(" ").replace(/-/g, ":");
        }
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
          const timeEl = document.getElementById("photo-time");
          timeEl.textContent = photo.time;
        };
        strip.appendChild(img);
      });
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
        select.innerHTML = '<option value="">None</option>';
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
  document.getElementById("sensor-temp").textContent =
    sensors.temp_c != null ? sensors.temp_c.toFixed(1) : "--";
}

function updateMqttStatus(connected) {
  const dot = document.getElementById("mqtt-status");
  dot.className = "status-dot " + (connected ? "connected" : "disconnected");
}

function updateAlerts(alerts) {
  const container = document.getElementById("alerts-container");
  const list = document.getElementById("alerts-list");
  if (!alerts || alerts.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";
  list.innerHTML = alerts
    .map((a) => '<div class="alert-item">' + esc(a) + "</div>")
    .join("");
}

function updateAISummary(data) {
  const el = document.getElementById("ai-summary");
  if (!data.summary) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  document.getElementById("ai-summary-text").textContent = data.summary;
  document.getElementById("ai-summary-date").textContent = data.analysis_date || "";

  const healthEl = document.getElementById("overall-health");
  if (data.overall_health != null) {
    healthEl.textContent = data.overall_health;
    healthEl.className = "sensor-val health-score health-" + data.overall_health;
  }
}

function updatePlantCards(plants) {
  const container = document.getElementById("plant-cards");
  container.innerHTML = "";

  plants.forEach((plant) => {
    const healthClass = plant.health_score != null ? "health-" + Math.min(plant.health_score, 4) : "";
    const badgeClass = plant.health_score >= 4 ? "good" : plant.health_score === 3 ? "fair" : "poor";

    const card = document.createElement("div");
    card.className = "plant-card " + healthClass;

    let html = '<div class="plant-card-header"><div>';
    html += '<div class="plant-name">' + esc(plant.name) + "</div>";
    html += '<div class="plant-species">' + esc(plant.species) + " &middot; " + esc(plant.position) + "</div>";
    html += "</div>";
    if (plant.health_score != null) {
      html += '<span class="health-badge ' + badgeClass + '">' + plant.health_score + "/5</span>";
    }
    html += "</div>";

    html += '<div class="plant-meta">';
    html += "<span>" + plant.age_days + " days old</span>";
    html += "<span>" + cap(plant.growth_stage) + "</span>";
    if (plant.days_to_harvest != null) {
      html += "<span>Harvest ~" + plant.days_to_harvest + "d</span>";
    }
    html += "</div>";

    html += '<div class="stage-bar"><div class="stage-bar-fill" style="width:' + plant.stage_progress + '%"></div></div>';

    if (plant.observations) {
      html += '<div class="plant-observations">' + esc(plant.observations) + "</div>";
    }
    if (plant.concerns) {
      html += '<div class="plant-concerns">' + esc(plant.concerns) + "</div>";
    }

    html += '<button class="plant-expand" onclick="toggleDetails(this)">Care guide</button>';
    html += '<div class="plant-details">';
    if (plant.advice) {
      plant.advice.forEach((a) => {
        const warn = a.toUpperCase().startsWith("WARNING") || a.toLowerCase().includes("below");
        html += '<div class="advice-item' + (warn ? " warning" : "") + '">' + esc(a) + "</div>";
      });
    }
    if (plant.harvest_tips) {
      html += '<div class="advice-item"><strong>Harvest:</strong> ' + esc(plant.harvest_tips) + "</div>";
    }
    html += "</div>";

    card.innerHTML = html;
    container.appendChild(card);
  });
}

// --- Actions ---

function loadLightState() {
  fetch("/api/light")
    .then((r) => r.json())
    .then((data) => {
      const btn = document.getElementById("light-btn");
      if (data.state != null) {
        btn.className = "header-btn " + (data.state ? "light-on" : "light-off");
      }
    })
    .catch(() => {});
}

function toggleLight() {
  const btn = document.getElementById("light-btn");
  btn.disabled = true;
  fetch("/api/light/toggle", { method: "POST" })
    .then((r) => r.json())
    .then((data) => {
      btn.disabled = false;
      if (data.state != null) {
        btn.className = "header-btn " + (data.state ? "light-on" : "light-off");
      }
    })
    .catch(() => {
      btn.disabled = false;
    });
}

function manualCapture() {
  const btn = document.getElementById("capture-btn");
  btn.disabled = true;
  btn.textContent = "...";
  fetch("/capture", { method: "POST" })
    .then((r) => r.json())
    .then(() => {
      btn.textContent = "Capture";
      btn.disabled = false;
      loadLatestPhoto();
      loadThumbnails(currentDate);
    })
    .catch(() => {
      btn.textContent = "Capture";
      btn.disabled = false;
    });
}

function toggleDetails(btn) {
  const details = btn.nextElementSibling;
  details.classList.toggle("open");
  btn.textContent = details.classList.contains("open") ? "Hide" : "Care guide";
}

function openFullscreen(img) {
  document.getElementById("fullscreen-img").src = img.src;
  document.getElementById("fullscreen-overlay").classList.add("open");
}

function closeFullscreen() {
  document.getElementById("fullscreen-overlay").classList.remove("open");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFullscreen();
});

// --- Helpers ---

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
