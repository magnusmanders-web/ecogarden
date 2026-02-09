// EcoGarden Plant Monitor

let currentDate = new Date().toISOString().split("T")[0];
let currentPhotoUrl = null;

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadThumbnails(currentDate);
  loadTimelapses();
  loadLightState();
  loadStorageStats();
  loadLightHistory("24h");

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
        currentPhotoUrl = data.url;
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
        const wrapper = document.createElement("div");
        wrapper.className = "thumb-wrapper";

        const img = document.createElement("img");
        img.src = photo.url;
        img.alt = photo.time;
        img.title = photo.time;
        if (i === photos.length - 1) img.classList.add("active");
        img.onclick = () => {
          document.getElementById("latest-photo").src = photo.url;
          currentPhotoUrl = photo.url;
          strip.querySelectorAll("img").forEach((t) => t.classList.remove("active"));
          img.classList.add("active");
          const timeEl = document.getElementById("photo-time");
          timeEl.textContent = photo.time;
        };

        const delBtn = document.createElement("button");
        delBtn.className = "thumb-delete";
        delBtn.textContent = "\u00d7";
        delBtn.onclick = (e) => {
          e.stopPropagation();
          deletePhoto(photo.url, dateStr);
        };

        wrapper.appendChild(img);
        wrapper.appendChild(delBtn);
        strip.appendChild(wrapper);
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
  // Cache-bust for regenerated timelapses
  video.src = "/timelapse/" + type + "/" + file + "?t=" + Date.now();
  video.load();
  video.style.display = "block";
  noData.style.display = "none";
}

// --- Storage ---

function loadStorageStats() {
  fetch("/api/storage")
    .then((r) => r.json())
    .then((data) => {
      document.getElementById("storage-photos").textContent = data.photos.count + " photos";
      document.getElementById("storage-size").textContent = data.total_size_mb + " MB";
      const tlCount = (data.timelapse.daily || 0) + (data.timelapse.weekly || 0);
      document.getElementById("storage-timelapses").textContent = tlCount + " timelapses";

      const pct = data.max_storage_mb > 0
        ? Math.min(100, (data.total_size_mb / data.max_storage_mb) * 100)
        : 0;
      const fill = document.getElementById("storage-bar-fill");
      fill.style.width = pct.toFixed(1) + "%";
      fill.className = "storage-bar-fill" + (pct > 80 ? " warning" : pct > 95 ? " critical" : "");

      const forecast = document.getElementById("storage-forecast");
      if (data.daily_avg_mb > 0) {
        let text = "~" + data.daily_avg_mb + " MB/day";
        if (data.forecast_days_to_full != null) {
          text += ", " + data.forecast_days_to_full + " days until full";
        }
        text += " (" + pct.toFixed(0) + "% of " + (data.max_storage_mb / 1024).toFixed(0) + " GB)";
        forecast.textContent = text;
      } else {
        forecast.textContent = "No data yet";
      }
    })
    .catch(() => {});
}

// --- Light History Chart ---

function loadLightHistory(range, btn) {
  if (btn) {
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }

  fetch("/api/sensors/light/history?range=" + range)
    .then((r) => r.json())
    .then((data) => {
      const svg = document.getElementById("light-chart");
      const noData = document.getElementById("light-no-data");

      if (!data.points || data.points.length === 0) {
        svg.style.display = "none";
        noData.style.display = "block";
        noData.textContent = data.error ? "Light data unavailable" : "No light data";
        return;
      }

      svg.style.display = "block";
      noData.style.display = "none";
      // InfluxDB stores raw 0-1 values; scale to 0-100%
      const scaled = data.points.map((p) => ({ time: p.time, value: p.value * 100 }));
      renderLightChart(svg, scaled, range);
    })
    .catch(() => {
      document.getElementById("light-chart").style.display = "none";
      document.getElementById("light-no-data").style.display = "block";
      document.getElementById("light-no-data").textContent = "Light data unavailable";
    });
}

function renderLightChart(svg, points, range) {
  const w = 600, h = 200;
  const padLeft = 36, padRight = 10, padTop = 10, padBottom = 28;
  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  // Find min/max values (0-100% light level)
  const maxVal = Math.max(100, ...points.map((p) => p.value));
  const minVal = 0;

  // Build polyline points
  const coords = points.map((p, i) => {
    const x = padLeft + (i / (points.length - 1)) * chartW;
    const y = padTop + chartH - ((p.value - minVal) / (maxVal - minVal)) * chartH;
    return { x, y };
  });

  const linePoints = coords.map((c) => c.x + "," + c.y).join(" ");
  const areaPath = "M" + coords[0].x + "," + (padTop + chartH) +
    " L" + coords.map((c) => c.x + "," + c.y).join(" L") +
    " L" + coords[coords.length - 1].x + "," + (padTop + chartH) + " Z";

  let html = "";

  // Grid lines and Y labels
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = padTop + chartH - (pct / 100) * chartH;
    html += '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (w - padRight) + '" y2="' + y + '" stroke="#e0e0e0" stroke-width="0.5"/>';
    html += '<text x="' + (padLeft - 4) + '" y="' + (y + 3) + '" text-anchor="end" fill="#888" font-size="10">' + pct + "%</text>";
  }

  // Area fill
  html += '<path d="' + areaPath + '" fill="rgba(34,128,74,0.12)"/>';
  // Line
  html += '<polyline points="' + linePoints + '" fill="none" stroke="#22804a" stroke-width="1.8" stroke-linejoin="round"/>';

  // Time labels (show ~5 labels)
  const labelCount = 5;
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / (labelCount - 1)) * (points.length - 1));
    const p = points[idx];
    const x = coords[idx].x;
    const t = new Date(p.time);
    let label;
    if (range === "24h") {
      label = t.getHours().toString().padStart(2, "0") + ":" + t.getMinutes().toString().padStart(2, "0");
    } else {
      label = (t.getMonth() + 1) + "/" + t.getDate();
    }
    html += '<text x="' + x + '" y="' + (h - 4) + '" text-anchor="middle" fill="#888" font-size="10">' + label + "</text>";
  }

  svg.innerHTML = html;
}

// --- Photo Deletion ---

function deletePhoto(photoUrl, dateStr) {
  if (!confirm("Delete this photo?")) return;

  // photoUrl is like /photos/2026-02-08/plant_12-30.jpg
  fetch("/api" + photoUrl, { method: "DELETE" })
    .then((r) => {
      if (r.ok) {
        loadThumbnails(dateStr || currentDate);
        loadLatestPhoto();
        loadStorageStats();
      }
    })
    .catch(() => {});
}

function deleteFullscreenPhoto() {
  const imgSrc = document.getElementById("fullscreen-img").src;
  if (!imgSrc) return;

  // Extract path from full URL
  const url = new URL(imgSrc);
  const path = url.pathname; // /photos/2026-02-08/plant_12-30.jpg

  if (!confirm("Delete this photo?")) return;

  fetch("/api" + path, { method: "DELETE" })
    .then((r) => {
      if (r.ok) {
        closeFullscreen();
        loadThumbnails(currentDate);
        loadLatestPhoto();
        loadStorageStats();
      }
    })
    .catch(() => {});
}

// --- Timelapse Generation ---

let timelapsePolling = null;

function generateTimelapse() {
  const type = document.getElementById("timelapse-type").value;
  let body;

  if (type === "daily") {
    const selected = document.getElementById("timelapse-select").value;
    const date = selected ? selected.replace(".mp4", "") : currentDate;
    body = JSON.stringify({ date: date });
  } else {
    // Derive ISO week from current date
    const d = new Date();
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    body = JSON.stringify({ year: d.getUTCFullYear(), week: weekNo });
  }

  const btn = document.getElementById("timelapse-gen-btn");
  btn.disabled = true;

  fetch("/api/timelapse/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body,
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        alert(data.error);
        btn.disabled = false;
        return;
      }
      const status = document.getElementById("timelapse-gen-status");
      const label = document.getElementById("timelapse-gen-label");
      status.style.display = "flex";
      label.textContent = "Generating " + data.type + " timelapse: " + data.label + "...";

      timelapsePolling = setInterval(pollTimelapseStatus, 2000);
    })
    .catch(() => {
      btn.disabled = false;
    });
}

function pollTimelapseStatus() {
  fetch("/api/timelapse/status")
    .then((r) => r.json())
    .then((data) => {
      if (!data.generating) {
        clearInterval(timelapsePolling);
        timelapsePolling = null;

        const status = document.getElementById("timelapse-gen-status");
        const btn = document.getElementById("timelapse-gen-btn");
        status.style.display = "none";
        btn.disabled = false;

        if (data.error) {
          alert("Timelapse failed: " + data.error);
        } else {
          loadTimelapses();
        }
      }
    })
    .catch(() => {});
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
