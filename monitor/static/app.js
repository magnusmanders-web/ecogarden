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
  loadTempHistory();

  setInterval(loadStatus, 60000);
  setInterval(loadTempHistory, 60000);
  setInterval(loadLatestPhoto, 300000);

  // Aquatic friends (desktop only) — delay so page renders first
  setTimeout(initFish, 2500);
  setTimeout(initBuddy, 10000);
  setTimeout(spawnTurtle, 35000);
  setTimeout(spawnShark, 70000);
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
      document.getElementById("storage-photos").textContent = data.photos.count;
      document.getElementById("storage-size").textContent = data.total_size_mb;
      const tlCount = (data.timelapse.daily || 0) + (data.timelapse.weekly || 0);
      document.getElementById("storage-timelapses").textContent = tlCount;

      const pct = data.max_storage_mb > 0
        ? Math.min(100, (data.total_size_mb / data.max_storage_mb) * 100)
        : 0;
      const fill = document.getElementById("storage-bar-fill");
      fill.style.width = pct.toFixed(1) + "%";
      fill.className = "storage-bar-fill" + (pct > 95 ? " critical" : pct > 80 ? " warning" : "");

      const forecast = document.getElementById("storage-forecast");
      if (data.daily_avg_mb > 0) {
        let text = "~" + data.daily_avg_mb + " MB/day";
        if (data.forecast_days_to_full != null) {
          text += " \u00b7 " + data.forecast_days_to_full + " days until full";
        }
        text += " \u00b7 " + pct.toFixed(0) + "% of " + (data.max_storage_mb / 1024).toFixed(0) + " GB";
        forecast.textContent = text;
      } else {
        forecast.textContent = "No usage data yet";
      }
    })
    .catch(() => {});
}

// --- Light History Chart ---

function loadLightHistory(range, btn) {
  if (btn) {
    document.querySelectorAll(".pill").forEach((b) => b.classList.remove("active"));
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

  // Defs for gradient fill
  html += '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">';
  html += '<stop offset="0%" stop-color="rgba(46,204,113,0.2)"/>';
  html += '<stop offset="100%" stop-color="rgba(46,204,113,0.01)"/>';
  html += '</linearGradient></defs>';

  // Grid lines and Y labels
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = padTop + chartH - (pct / 100) * chartH;
    html += '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (w - padRight) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>';
    html += '<text x="' + (padLeft - 4) + '" y="' + (y + 3) + '" text-anchor="end" fill="#4a6b52" font-size="10" font-family="DM Sans, sans-serif">' + pct + "%</text>";
  }

  // Area fill
  html += '<path d="' + areaPath + '" fill="url(#areaGrad)"/>';
  // Line
  html += '<polyline points="' + linePoints + '" fill="none" stroke="#2ecc71" stroke-width="1.8" stroke-linejoin="round"/>';

  // Glow effect on the line
  html += '<polyline points="' + linePoints + '" fill="none" stroke="#2ecc71" stroke-width="4" stroke-linejoin="round" opacity="0.15" filter="blur(3px)"/>';

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
    html += '<text x="' + x + '" y="' + (h - 4) + '" text-anchor="middle" fill="#4a6b52" font-size="10" font-family="DM Sans, sans-serif">' + label + "</text>";
  }

  svg.innerHTML = html;
}

// --- Temperature History Chart ---

function loadTempHistory() {
  fetch("/api/sensors/temp/history")
    .then((r) => r.json())
    .then((data) => {
      const svg = document.getElementById("temp-chart");
      const noData = document.getElementById("temp-no-data");

      if (!data.points || data.points.length < 2) {
        svg.style.display = "none";
        noData.style.display = "block";
        return;
      }

      svg.style.display = "block";
      noData.style.display = "none";
      renderTempChart(svg, data.points);
    })
    .catch(() => {});
}

function renderTempChart(svg, points) {
  const w = 600, h = 200;
  const padLeft = 40, padRight = 10, padTop = 10, padBottom = 28;
  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  const values = points.map((p) => p.value);
  const minVal = Math.floor(Math.min(...values) - 0.5);
  const maxVal = Math.ceil(Math.max(...values) + 0.5);
  const range = maxVal - minVal || 1;

  const coords = points.map((p, i) => {
    const x = padLeft + (i / (points.length - 1)) * chartW;
    const y = padTop + chartH - ((p.value - minVal) / range) * chartH;
    return { x, y };
  });

  const linePoints = coords.map((c) => c.x + "," + c.y).join(" ");
  const areaPath = "M" + coords[0].x + "," + (padTop + chartH) +
    " L" + coords.map((c) => c.x + "," + c.y).join(" L") +
    " L" + coords[coords.length - 1].x + "," + (padTop + chartH) + " Z";

  let html = "";

  html += '<defs><linearGradient id="tempAreaGrad" x1="0" y1="0" x2="0" y2="1">';
  html += '<stop offset="0%" stop-color="rgba(52,152,219,0.25)"/>';
  html += '<stop offset="100%" stop-color="rgba(52,152,219,0.02)"/>';
  html += '</linearGradient></defs>';

  // Grid lines and Y labels
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = minVal + (range * i) / steps;
    const y = padTop + chartH - (i / steps) * chartH;
    html += '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (w - padRight) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>';
    html += '<text x="' + (padLeft - 4) + '" y="' + (y + 3) + '" text-anchor="end" fill="#4a6b52" font-size="10" font-family="DM Sans, sans-serif">' + val.toFixed(1) + "\u00b0</text>";
  }

  html += '<path d="' + areaPath + '" fill="url(#tempAreaGrad)"/>';
  html += '<polyline points="' + linePoints + '" fill="none" stroke="#3498db" stroke-width="1.8" stroke-linejoin="round"/>';
  html += '<polyline points="' + linePoints + '" fill="none" stroke="#3498db" stroke-width="4" stroke-linejoin="round" opacity="0.15" filter="blur(3px)"/>';

  // Time labels
  const labelCount = 5;
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / (labelCount - 1)) * (points.length - 1));
    const p = points[idx];
    const x = coords[idx].x;
    const t = new Date(p.time);
    const label = t.getHours().toString().padStart(2, "0") + ":" + t.getMinutes().toString().padStart(2, "0");
    html += '<text x="' + x + '" y="' + (h - 4) + '" text-anchor="middle" fill="#4a6b52" font-size="10" font-family="DM Sans, sans-serif">' + label + "</text>";
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
    body = JSON.stringify({ date: currentDate });
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

        const statusEl = document.getElementById("timelapse-gen-status");
        const btn = document.getElementById("timelapse-gen-btn");
        statusEl.style.display = "none";
        btn.disabled = false;

        if (data.error) {
          alert("Timelapse failed: " + data.error);
        } else {
          // Reload list and select the newly generated file
          const newFile = data.result;
          fetch("/api/timelapse")
            .then((r) => r.json())
            .then((list) => {
              const type = document.getElementById("timelapse-type").value;
              const select = document.getElementById("timelapse-select");
              const videos = list[type] || [];
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
                if (v === newFile) opt.selected = true;
                select.appendChild(opt);
              });
              playTimelapse();
            })
            .catch(() => {});
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
  const text = document.getElementById("header-sub-text");
  text.textContent = connected ? "Connected" : "Disconnected";
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
    healthEl.className = "orb-val health-score health-" + data.overall_health;
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
        btn.className = "ctrl-btn " + (data.state ? "light-on" : "light-off");
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
        btn.className = "ctrl-btn " + (data.state ? "light-on" : "light-off");
      }
    })
    .catch(() => {
      btn.disabled = false;
    });
}

function manualCapture() {
  const btn = document.getElementById("capture-btn");
  btn.disabled = true;
  fetch("/capture", { method: "POST" })
    .then((r) => r.json())
    .then(() => {
      btn.disabled = false;
      loadLatestPhoto();
      loadThumbnails(currentDate);
    })
    .catch(() => {
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

// --- Fish Buddy: "Bubbles" the Aquaponic Koi ---

const fishTips = {
  oregano: [
    { type: "recipe", text: "<strong>Oregano oil pasta:</strong> Saut\u00e9 garlic in olive oil, toss with spaghetti, and finish with torn fresh oregano leaves." },
    { type: "recipe", text: "<strong>Greek salad boost:</strong> Fresh oregano with cucumber, tomato, feta & olives \u2014 the authentic touch!" },
    { type: "recipe", text: "<strong>Oregano butter:</strong> Mix chopped oregano into softened butter with lemon zest. Great on grilled fish\u2026 no, not me!" },
    { type: "recipe", text: "<strong>Chimichurri:</strong> Blend oregano, parsley, garlic, red wine vinegar & olive oil. Perfect on steak!" },
    { type: "tip", text: "<strong>Harvest tip:</strong> Pinch oregano stems just above a leaf pair to encourage bushy growth." },
    { type: "tip", text: "<strong>Did you know?</strong> Oregano's flavor intensifies near flowering. Harvest just before for peak taste!" },
    { type: "tip", text: "<strong>Pro tip:</strong> Oregano prefers slightly drier conditions. Don't overwater between cycles." },
  ],
  basil: [
    { type: "recipe", text: "<strong>Caprese perfection:</strong> Layer thick tomato slices, fresh mozzarella & basil. Drizzle with good olive oil." },
    { type: "recipe", text: "<strong>Thai basil stir-fry:</strong> Works great in pad kra pao! Toss basil in at the very end." },
    { type: "recipe", text: "<strong>Basil lemonade:</strong> Muddle basil leaves with lemon juice, add simple syrup & cold water. So refreshing!" },
    { type: "recipe", text: "<strong>Pesto time!</strong> Blend basil, pine nuts, parmesan, garlic & olive oil. Freeze extra in ice cube trays." },
    { type: "recipe", text: "<strong>Basil ice cream:</strong> Steep basil in warm cream, strain, churn. Trust me on this one." },
    { type: "tip", text: "<strong>Pinch it!</strong> Always harvest basil from the top down. Pinch above a leaf pair to get two new branches." },
    { type: "tip", text: "<strong>Flower watch:</strong> Remove flower buds immediately \u2014 they make the leaves bitter." },
    { type: "tip", text: "<strong>Warmth lover:</strong> Basil thrives in warm water. Keep temps above 20\u00b0C for happy leaves." },
  ],
  lettuce: [
    { type: "recipe", text: "<strong>Garden wraps:</strong> Use large lettuce leaves as wraps for chicken, avocado & pickled veggies!" },
    { type: "recipe", text: "<strong>Green smoothie:</strong> Blend lettuce with banana, apple & ginger. Mild flavor, great nutrition." },
    { type: "recipe", text: "<strong>Grilled lettuce?!</strong> Yes! Halve a head, grill 60 sec per side, drizzle with Caesar dressing." },
    { type: "recipe", text: "<strong>Lettuce soup:</strong> Saut\u00e9 onion, add lettuce & stock, blend. Surprisingly elegant." },
    { type: "tip", text: "<strong>Cut-and-come-again:</strong> Harvest outer leaves first. The center keeps growing for weeks!" },
    { type: "tip", text: "<strong>Bolting alert:</strong> If lettuce starts stretching tall, it's bolting. Harvest immediately \u2014 it'll turn bitter." },
    { type: "tip", text: "<strong>Light matters:</strong> Lettuce prefers 12\u201314 hours of light. Too much causes stress and bitterness." },
  ],
  general: [
    { type: "tip", text: "<strong>Aquaponic fact:</strong> I feed the plants, and the plants clean my water. We're a team!" },
    { type: "tip", text: "<strong>Water temp:</strong> Ideal range is 18\u201326\u00b0C. Outside that, both fish and plants get stressed." },
    { type: "tip", text: "<strong>Harvest mornings!</strong> Herbs have the most essential oils in the morning before the heat." },
    { type: "tip", text: "<strong>Rotate harvests:</strong> Don't strip one plant bare. Take a little from each to keep them all healthy." },
    { type: "recipe", text: "<strong>Herb ice cubes:</strong> Chop fresh herbs, pack into ice cube trays, cover with olive oil & freeze." },
    { type: "recipe", text: "<strong>Herb salt:</strong> Blend fresh herbs with coarse sea salt, spread on a tray & dry. Keeps for months!" },
    { type: "recipe", text: "<strong>Garden tea:</strong> Steep fresh herbs in hot water \u2014 basil-mint is my favorite combo." },
    { type: "tip", text: "<strong>Root check:</strong> Healthy aquaponic roots are white. Brown or slimy? Time to investigate." },
  ]
};

const fishNames = [
  "Bubbles says\u2026", "Chef Bubbles says\u2026", "Bubbles knows\u2026",
  "Your fish friend says\u2026", "Bubbles recommends\u2026",
];

let fish = {
  el: null, x: 0, y: 0, tx: 0, ty: 0, angle: 0,
  facingLeft: true, moving: false, speed: 1.2,
  tipIdx: 0, trickCooldown: 0, mouseX: 0, mouseY: 0,
  bubbleTimer: 0, lastBubble: 0, dashUntil: 0,
};
let fishFrame = null;
let fishTipTimer = null;
let knownHerbs = [];

function initFish() {
  if (window.innerWidth < 768) return;

  fish.el = document.getElementById("fish");
  if (!fish.el) return;

  fish.el.style.display = "block";
  fish.el.style.left = "0px";
  fish.el.style.top = "0px";

  // Start off-screen right, swim in
  fish.x = window.innerWidth + 40;
  fish.y = window.innerHeight * 0.4;
  fish.el.style.transform = "translate(" + fish.x + "px," + fish.y + "px)";

  // Track mouse for fish awareness
  document.addEventListener("mousemove", (e) => {
    fish.mouseX = e.clientX;
    fish.mouseY = e.clientY;
  });

  // First swim target: toward center
  fish.tx = window.innerWidth * 0.6;
  fish.ty = window.innerHeight * 0.35;
  fish.moving = true;
  fish.facingLeft = true;

  fishFrame = requestAnimationFrame(fishLoop);
  scheduleTip();
}

function fishPickTarget() {
  const margin = 90;
  const w = window.innerWidth;
  const h = window.innerHeight;

  // Occasionally swim toward mouse
  if (Math.random() < 0.15 && fish.mouseX > 0) {
    fish.tx = fish.mouseX + (Math.random() - 0.5) * 120;
    fish.ty = fish.mouseY + (Math.random() - 0.5) * 80;
  } else {
    fish.tx = margin + Math.random() * (w - margin * 2 - 80);
    fish.ty = 70 + Math.random() * (h - 220);
  }

  // Clamp within bounds
  fish.tx = Math.max(50, Math.min(w - 100, fish.tx));
  fish.ty = Math.max(60, Math.min(h - 100, fish.ty));

  fish.facingLeft = fish.tx < fish.x;
  fish.moving = true;
  fish.speed = 0.8 + Math.random() * 1.2;
  fish.el.classList.remove("paused", "dashing");

  // Random chance of a dash (speed burst)
  if (Math.random() < 0.12) {
    fish.speed = 3.5;
    fish.dashUntil = Date.now() + 800;
    fish.el.classList.add("dashing");
  }
}

function fishLoop(time) {
  if (!fish.el) return;
  fishFrame = requestAnimationFrame(fishLoop);

  // Check dash expiry
  if (fish.dashUntil && Date.now() > fish.dashUntil) {
    fish.dashUntil = 0;
    fish.speed = Math.max(fish.speed * 0.4, 0.8);
    fish.el.classList.remove("dashing");
  }

  if (!fish.moving) return;

  const dx = fish.tx - fish.x;
  const dy = fish.ty - fish.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 4) {
    fish.moving = false;
    fish.x = fish.tx;
    fish.y = fish.ty;
    fish.el.classList.add("paused");
    fish.el.classList.remove("dashing");

    // Random pause, then swim again
    const pause = 1500 + Math.random() * 3500;
    setTimeout(fishPickTarget, pause);
    return;
  }

  // Smooth movement with ease
  const ease = Math.min(fish.speed, dist * 0.025);
  fish.x += (dx / dist) * ease;
  fish.y += (dy / dist) * ease;

  // Perpendicular wave for organic swimming
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const waveAmt = Math.sin(time * 0.004) * 3.5;
  const drawX = fish.x + perpX * waveAmt;
  const drawY = fish.y + perpY * waveAmt;

  // Tilt toward movement direction
  const targetAngle = Math.atan2(dy, dx) * (180 / Math.PI);
  fish.angle += (targetAngle - fish.angle) * 0.08;
  const tilt = Math.max(-18, Math.min(18, fish.angle * 0.3));

  const scaleX = fish.facingLeft ? 1 : -1;
  fish.el.style.transform =
    "translate(" + drawX.toFixed(1) + "px," + drawY.toFixed(1) + "px) " +
    "scaleX(" + scaleX + ") rotate(" + tilt.toFixed(1) + "deg)";

  // Spawn bubbles while swimming
  if (time - fish.lastBubble > 400 + Math.random() * 300) {
    spawnBubble();
    fish.lastBubble = time;
  }
}

function spawnBubble() {
  const container = document.getElementById("fish-bubbles");
  if (!container) return;

  const bub = document.createElement("div");
  bub.className = "fish-bub";
  const size = 3 + Math.random() * 5;
  bub.style.width = size + "px";
  bub.style.height = size + "px";
  bub.style.setProperty("--bx", (25 + Math.random() * 20) + "px");
  bub.style.setProperty("--by", (10 + Math.random() * 20) + "px");
  bub.style.setProperty("--drift", (Math.random() - 0.5) * 30 + "px");
  bub.style.setProperty("--dur", (1 + Math.random() * 0.8) + "s");
  container.appendChild(bub);

  setTimeout(() => bub.remove(), 2000);
}

function scheduleTip() {
  const delay = 20000 + Math.random() * 15000;
  fishTipTimer = setTimeout(showFishTip, delay);
}

function showFishTip() {
  if (!fish.el) return;
  const headerEl = document.getElementById("fish-speech-header");
  const textEl = document.getElementById("fish-speech-text");
  const speechEl = document.getElementById("fish-speech");
  if (!headerEl || !textEl || !speechEl) return;

  // Build pool
  let pool = [...fishTips.general];
  knownHerbs.forEach((h) => {
    const key = h.toLowerCase();
    if (fishTips[key]) pool = pool.concat(fishTips[key]);
  });

  if (pool.length === 0) { scheduleTip(); return; }

  // Shuffle on first pass through
  if (fish.tipIdx === 0) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  const tip = pool[fish.tipIdx % pool.length];
  fish.tipIdx++;

  // Set header style based on type
  const name = fishNames[Math.floor(Math.random() * fishNames.length)];
  const isRecipe = tip.type === "recipe";
  headerEl.className = "fish-speech-header " + (isRecipe ? "recipe-header" : "tip-header");
  headerEl.innerHTML = (isRecipe ? "\uD83C\uDF73 " : "\uD83C\uDF31 ") + name;

  textEl.innerHTML = tip.text;

  // Pause swimming and show speech bubble
  fish.moving = false;
  cancelAnimationFrame(fishFrame);
  fish.el.classList.add("paused", "talking");

  // Do a little bounce for recipes, stay calm for tips
  if (isRecipe) {
    fish.el.classList.add("trick-bounce");
    setTimeout(() => fish.el.classList.remove("trick-bounce"), 600);
  }

  // The fish parent has scaleX(1) or scaleX(-1). The speech bubble inherits
  // that, so always counter-flip it to keep text readable.
  const scaleX = fish.facingLeft ? 1 : -1;
  speechEl.style.transform = "translateX(-50%) translateY(0) scale(1) scaleX(" + scaleX + ")";

  // Hide after 7 seconds
  setTimeout(() => {
    fish.el.classList.remove("talking");
    setTimeout(() => {
      fishFrame = requestAnimationFrame(fishLoop);
      fishPickTarget();
    }, 500);
    scheduleTip();
  }, 7000);
}

// Click the fish for a happy spin!
function fishClick() {
  if (!fish.el) return;
  fish.el.classList.add("trick-spin");
  setTimeout(() => fish.el.classList.remove("trick-spin"), 700);

  // Burst of bubbles
  for (let i = 0; i < 6; i++) {
    setTimeout(spawnBubble, i * 80);
  }
}

// Hook into plant data loading to learn which herbs we have
const _origUpdatePlantCards = updatePlantCards;
updatePlantCards = function(plants) {
  _origUpdatePlantCards(plants);
  knownHerbs = plants.map((p) => p.species).filter(Boolean);
};

// Pause fish when tab is hidden
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(fishFrame);
    clearTimeout(fishTipTimer);
    cancelAnimationFrame(buddy.frame);
    clearTimeout(buddy.quoteTimer);
  } else if (fish.el) {
    fishFrame = requestAnimationFrame(fishLoop);
    if (!fish.moving) fishPickTarget();
    scheduleTip();
    if (buddy.el) buddy.frame = requestAnimationFrame(buddyLoop);
  }
});

// --- Buddy Fish: "Gill" ---

const buddySvg = '<svg viewBox="0 0 60 38" fill="none"><defs><radialGradient id="bBody" cx="38%" cy="40%" r="55%"><stop offset="0%" stop-color="#88ddff"/><stop offset="45%" stop-color="#44aadd"/><stop offset="100%" stop-color="#2277aa"/></radialGradient><linearGradient id="bFin" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#66ccee" stop-opacity="0.8"/><stop offset="100%" stop-color="#2288bb" stop-opacity="0.4"/></linearGradient></defs><g class="fish-tail-g"><path d="M44 19 Q49 8 56 4 Q52 14 50 19 Q52 24 56 34 Q49 30 44 19Z" fill="#3399cc" opacity="0.8"/></g><path d="M22 8 Q25 1 32 5 Q30 8 26 9Z" fill="#55bbdd" opacity="0.7"/><ellipse cx="28" cy="19" rx="19" ry="13" fill="url(#bBody)"/><ellipse cx="26" cy="23" rx="12" ry="6" fill="white" opacity="0.07"/><path d="M24 10 Q28 19 24 28" fill="none" stroke="#66ccee" stroke-width="1.5" opacity="0.2"/><path d="M30 11 Q34 19 30 27" fill="none" stroke="#66ccee" stroke-width="1.5" opacity="0.15"/><g class="fish-pec-g"><path d="M25 28 Q20 35 27 37 Q28 32 26 28Z" fill="url(#bFin)"/></g><ellipse cx="17" cy="16" rx="4.5" ry="5" fill="white"/><ellipse cx="16" cy="15.5" rx="3" ry="3.5" fill="#1a1a2e"/><circle cx="14.5" cy="14" r="1.3" fill="white" opacity="0.9"/><path d="M10 22 Q13 25 16 23" fill="none" stroke="#1a6688" stroke-width="1" stroke-linecap="round"/><ellipse cx="19" cy="22" rx="3" ry="2" fill="#66aaff" opacity="0.12"/></svg>';

const buddyQuotes = [
  "Is that basil? I can smell it from here!",
  "I tried cooking once. Nearly burned the ocean down.",
  "My dating profile says \u2018great swimmer\u2019. Technically true.",
  "Do these scales make me look fat?",
  "My therapist says I need to stop going with the flow.",
  "I told a shrimp joke. It was a little shellfish.",
  "The rent here is free. Landlord\u2019s a bit wet though.",
  "I\u2019m not lost. I\u2019m on an adventure. Big difference.",
  "Water you looking at?",
  "That lettuce gives me weird looks. I think it knows things.",
  "Plot twist: I\u2019m a vegetarian fish. \u2026 Kidding. Or am I?",
  "Fun fact: my memory is exactly 3 sec\u2014 what were we saying?",
  "If I had legs I\u2019d be unstoppable. Terrifying, even.",
  "I\u2019ve been thinking about getting into crypto. AquaCoin.",
  "Bubbles thinks he\u2019s the star. I\u2019m clearly the funny one.",
  "Is it just me or is it wet everywhere?",
  "I just want you to know\u2026 I believe in you. And your herbs.",
  "I\u2019m not saying I\u2019m fast, but I once outran a current.",
];

let buddy = {
  el: null, x: 0, y: 0, tx: 0, ty: 0, facingLeft: true,
  moving: false, speed: 1, frame: null, quoteTimer: null, quoteIdx: 0,
};

function initBuddy() {
  if (window.innerWidth < 768 || buddy.el) return;

  const el = document.createElement("div");
  el.className = "buddy";
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";
  el.innerHTML = '<div class="buddy-body">' + buddySvg + '</div><div class="buddy-speech"></div>';
  el.onclick = buddyClick;
  document.body.appendChild(el);
  buddy.el = el;

  // Start at left edge, swim toward Bubbles
  buddy.x = 30;
  buddy.y = window.innerHeight * 0.6;
  buddy.el.style.transform = "translate(" + buddy.x + "px," + buddy.y + "px)";

  buddy.tx = window.innerWidth * 0.3;
  buddy.ty = window.innerHeight * 0.5;
  buddy.facingLeft = false;
  buddy.moving = true;
  buddy.speed = 1;

  buddy.frame = requestAnimationFrame(buddyLoop);
  scheduleBuddyQuote();
}

function buddyPickTarget() {
  // Follow Bubbles loosely — stay 80-200px away
  const offsetX = (Math.random() - 0.5) * 200;
  const offsetY = (Math.random() - 0.5) * 150;
  buddy.tx = Math.max(50, Math.min(window.innerWidth - 80, fish.x + offsetX));
  buddy.ty = Math.max(60, Math.min(window.innerHeight - 80, fish.y + offsetY));
  buddy.facingLeft = buddy.tx < buddy.x;
  buddy.moving = true;
  buddy.speed = 0.6 + Math.random() * 0.8;
  buddy.el.classList.remove("paused");
}

function buddyLoop(time) {
  if (!buddy.el) return;
  buddy.frame = requestAnimationFrame(buddyLoop);
  if (!buddy.moving) return;

  const dx = buddy.tx - buddy.x;
  const dy = buddy.ty - buddy.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 4) {
    buddy.moving = false;
    buddy.x = buddy.tx;
    buddy.y = buddy.ty;
    buddy.el.classList.add("paused");
    setTimeout(buddyPickTarget, 2000 + Math.random() * 3000);
    return;
  }

  const ease = Math.min(buddy.speed, dist * 0.02);
  buddy.x += (dx / dist) * ease;
  buddy.y += (dy / dist) * ease;

  const wave = Math.sin(time * 0.0045) * 2.5;
  const scaleX = buddy.facingLeft ? 1 : -1;
  buddy.el.style.transform =
    "translate(" + buddy.x.toFixed(1) + "px," + (buddy.y + wave).toFixed(1) + "px) scaleX(" + scaleX + ")";
}

function scheduleBuddyQuote() {
  buddy.quoteTimer = setTimeout(showBuddyQuote, 30000 + Math.random() * 20000);
}

function showBuddyQuote() {
  if (!buddy.el) return;
  const speech = buddy.el.querySelector(".buddy-speech");
  if (!speech) return;

  const quote = buddyQuotes[buddy.quoteIdx % buddyQuotes.length];
  buddy.quoteIdx++;

  const scaleX = buddy.facingLeft ? 1 : -1;
  speech.textContent = quote;
  speech.style.transform = "translateX(-50%) translateY(0) scale(1) scaleX(" + scaleX + ")";

  buddy.moving = false;
  buddy.el.classList.add("paused", "talking");

  setTimeout(() => {
    buddy.el.classList.remove("talking");
    setTimeout(buddyPickTarget, 500);
    scheduleBuddyQuote();
  }, 5000);
}

function buddyClick() {
  if (!buddy.el) return;
  buddy.el.querySelector(".buddy-body").style.animation = "trickSpin 0.6s cubic-bezier(0.25,1,0.5,1)";
  setTimeout(() => {
    buddy.el.querySelector(".buddy-body").style.animation = "";
  }, 700);
}

// Buddy is spawned from DOMContentLoaded

// --- Sea Turtle ---

const turtleSvg = '<svg viewBox="0 0 70 50" fill="none"><defs><radialGradient id="tShell" cx="45%" cy="45%" r="50%"><stop offset="0%" stop-color="#7ab856"/><stop offset="100%" stop-color="#4a7a32"/></radialGradient></defs><ellipse class="turtle-flipper-fl" cx="18" cy="14" rx="9" ry="3.5" fill="#6aa846" transform="rotate(-15 18 14)"/><ellipse class="turtle-flipper-bl" cx="20" cy="40" rx="9" ry="3.5" fill="#6aa846" transform="rotate(15 20 40)"/><ellipse class="turtle-flipper-fr" cx="50" cy="16" rx="7" ry="3" fill="#6aa846" transform="rotate(10 50 16)"/><ellipse class="turtle-flipper-br" cx="48" cy="38" rx="7" ry="3" fill="#6aa846" transform="rotate(-10 48 38)"/><ellipse cx="35" cy="27" rx="20" ry="15" fill="url(#tShell)"/><path d="M35 14 L28 22 L35 27 L42 22Z" fill="#5a9a3c" stroke="#4a7a28" stroke-width="0.5" opacity="0.6"/><path d="M28 22 L20 27 L28 34 L35 27Z" fill="#5a9a3c" stroke="#4a7a28" stroke-width="0.5" opacity="0.6"/><path d="M42 22 L50 27 L42 34 L35 27Z" fill="#5a9a3c" stroke="#4a7a28" stroke-width="0.5" opacity="0.6"/><path d="M28 34 L22 38 L30 40 L35 27Z" fill="#5a9a3c" stroke="#4a7a28" stroke-width="0.5" opacity="0.4"/><path d="M42 34 L48 38 L40 40 L35 27Z" fill="#5a9a3c" stroke="#4a7a28" stroke-width="0.5" opacity="0.4"/><ellipse cx="12" cy="24" rx="9" ry="7" fill="#7ab856"/><circle cx="8" cy="22" r="2.8" fill="white"/><circle cx="7.5" cy="21.5" r="1.7" fill="#1a2a1e"/><circle cx="7" cy="21" r="0.6" fill="white"/><path d="M6 27 Q8 29 11 27" fill="none" stroke="#3d6428" stroke-width="0.8" stroke-linecap="round"/><path d="M52 25 Q56 24 58 26 Q56 28 52 27Z" fill="#6aa846" opacity="0.6"/></svg>';

const turtleQuotes = [
  "Slow and steady\u2026 you know the rest.",
  "Just passing through. Nice garden you got.",
  "I\u2019ve been swimming for 80 years. Still enjoying it.",
  "Remember: patience grows the best herbs.",
  "Namaste, little fishies.",
  "The ocean is vast, but this garden is lovely.",
  "Don\u2019t rush. Good things take time.",
];

let turtleTimer = null;

function scheduleTurtle() {
  turtleTimer = setTimeout(spawnTurtle, 45000 + Math.random() * 45000);
}

function spawnTurtle() {
  if (window.innerWidth < 768) { scheduleTurtle(); return; }

  const el = document.createElement("div");
  el.className = "sea-turtle";
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";

  const quote = turtleQuotes[Math.floor(Math.random() * turtleQuotes.length)];
  el.innerHTML = '<div class="turtle-body">' + turtleSvg + '</div><div class="turtle-speech">' + quote + '</div>';
  document.body.appendChild(el);

  // Swim from left to right or right to left
  const fromLeft = Math.random() > 0.5;
  const y = 100 + Math.random() * (window.innerHeight - 250);
  let x = fromLeft ? -80 : window.innerWidth + 80;
  const targetX = fromLeft ? window.innerWidth + 80 : -80;
  const scaleX = fromLeft ? -1 : 1;
  const speed = 0.4 + Math.random() * 0.3;

  el.style.transform = "translate(" + x + "px," + y + "px) scaleX(" + scaleX + ")";

  // Show quote when turtle is in the middle third of the screen
  let quoteShown = false;
  let quoteHidden = false;

  function turtleMove() {
    x += (fromLeft ? speed : -speed);
    const wave = Math.sin(Date.now() * 0.001) * 4;
    el.style.transform = "translate(" + x.toFixed(1) + "px," + (y + wave).toFixed(1) + "px) scaleX(" + scaleX + ")";

    const screenX = fromLeft ? x : window.innerWidth - x;
    if (!quoteShown && screenX > window.innerWidth * 0.3) {
      el.classList.add("talking");
      el.querySelector(".turtle-speech").style.transform = "translateX(-50%) scaleX(" + scaleX + ")";
      quoteShown = true;
    }
    if (!quoteHidden && screenX > window.innerWidth * 0.7) {
      el.classList.remove("talking");
      quoteHidden = true;
    }

    if ((fromLeft && x > window.innerWidth + 100) || (!fromLeft && x < -100)) {
      el.remove();
      scheduleTurtle();
      return;
    }
    requestAnimationFrame(turtleMove);
  }
  requestAnimationFrame(turtleMove);
}

// Turtle is spawned from DOMContentLoaded

// --- Shark Attack! ---

const sharkSvg = '<svg viewBox="0 0 90 50" fill="none"><defs><linearGradient id="sBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6b7b8d"/><stop offset="50%" stop-color="#566878"/><stop offset="100%" stop-color="#8899aa"/></linearGradient></defs><g class="shark-tail-g"><path d="M8 25 L-6 10 Q2 18 0 25 Q2 32 -6 40Z" fill="#556677"/></g><path d="M38 6 L42 -6 L48 6Z" fill="#556677"/><path d="M10 25 Q18 8 45 6 Q72 4 82 22 L84 25 L82 28 Q72 46 45 44 Q18 42 10 25Z" fill="url(#sBody)"/><path d="M18 30 Q40 42 75 32 Q55 40 22 34Z" fill="#99aabb" opacity="0.3"/><line x1="60" y1="16" x2="60" y2="30" stroke="#4a5a6a" stroke-width="0.8"/><line x1="57" y1="17" x2="57" y2="29" stroke="#4a5a6a" stroke-width="0.8"/><line x1="54" y1="18" x2="54" y2="28" stroke="#4a5a6a" stroke-width="0.8"/><circle cx="73" cy="19" r="4.5" fill="white"/><circle cx="74.5" cy="18.5" r="3" fill="#cc0000"/><circle cx="75.5" cy="17.5" r="1" fill="#ff4444" opacity="0.8"/><path d="M78 27 L80 32 L82 27 L84 32 L85 25" fill="white"/><path d="M78 23 L80 18 L82 23 L84 18 L85 25" fill="white"/><path d="M20 28 Q15 36 22 40 Q24 34 22 28Z" fill="#667788" opacity="0.6"/></svg>';

let shark = { el: null, x: 0, y: 0, active: false, frame: null };
let sharkTimer = null;
let sharkKills = 0;

function scheduleShark() {
  sharkTimer = setTimeout(spawnShark, 60000 + Math.random() * 60000);
}

function spawnShark() {
  if (window.innerWidth < 768 || !fish.el || shark.active) { scheduleShark(); return; }

  shark.active = true;
  const el = document.createElement("div");
  el.className = "shark";
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";
  el.innerHTML = '<div class="shark-glow"></div><div class="shark-body">' + sharkSvg + '</div>';
  el.onclick = killShark;
  document.body.appendChild(el);
  shark.el = el;

  // Enter from opposite side of Bubbles
  const fromLeft = fish.x > window.innerWidth / 2;
  shark.x = fromLeft ? -100 : window.innerWidth + 100;
  shark.y = 60 + Math.random() * (window.innerHeight - 180);
  el.style.transform = "translate(" + shark.x + "px," + shark.y + "px)";

  // Panic mode for Bubbles and Buddy!
  fish.el.classList.add("panicking");
  if (buddy.el) buddy.el.classList.add("panicking");

  // Add exclamation mark to Bubbles
  const exclaim = document.createElement("div");
  exclaim.className = "fish-exclaim";
  exclaim.textContent = "!!";
  fish.el.appendChild(exclaim);

  shark.frame = requestAnimationFrame(sharkChase);

  // Shark gives up after 12 seconds if not killed
  setTimeout(() => {
    if (shark.active && shark.el) {
      sharkRetreat();
    }
  }, 12000);
}

function sharkChase(time) {
  if (!shark.el || !shark.active) return;

  // Chase Bubbles
  const dx = fish.x - shark.x;
  const dy = fish.y - shark.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const speed = 1.8;
  if (dist > 10) {
    shark.x += (dx / dist) * speed;
    shark.y += (dy / dist) * speed;
  }

  const facingLeft = dx < 0;
  const scaleX = facingLeft ? -1 : 1;
  const wave = Math.sin(time * 0.005) * 3;
  shark.el.style.transform =
    "translate(" + shark.x.toFixed(1) + "px," + (shark.y + wave).toFixed(1) + "px) scaleX(" + scaleX + ")";

  // Make Bubbles flee!
  if (fish.moving || true) {
    const fleeX = fish.x + (fish.x - shark.x) * 0.5;
    const fleeY = fish.y + (fish.y - shark.y) * 0.5;
    fish.tx = Math.max(40, Math.min(window.innerWidth - 60, fleeX));
    fish.ty = Math.max(50, Math.min(window.innerHeight - 60, fleeY));
    fish.facingLeft = fish.tx < fish.x;
    fish.moving = true;
    fish.speed = 3;
    fish.el.classList.remove("paused", "talking");
  }

  // Also make buddy flee
  if (buddy.el && buddy.moving !== undefined) {
    const bFleeX = buddy.x + (buddy.x - shark.x) * 0.3;
    const bFleeY = buddy.y + (buddy.y - shark.y) * 0.3;
    buddy.tx = Math.max(40, Math.min(window.innerWidth - 60, bFleeX));
    buddy.ty = Math.max(50, Math.min(window.innerHeight - 60, bFleeY));
    buddy.facingLeft = buddy.tx < buddy.x;
    buddy.moving = true;
    buddy.speed = 2.5;
    buddy.el.classList.remove("paused", "talking");
  }

  shark.frame = requestAnimationFrame(sharkChase);
}

function killShark(e) {
  e.stopPropagation();
  if (!shark.el || !shark.active) return;
  shark.active = false;
  cancelAnimationFrame(shark.frame);

  sharkKills++;

  // Death animation
  shark.el.classList.add("hit");
  shark.el.style.setProperty("--pos",
    "translate(" + shark.x.toFixed(0) + "px," + shark.y.toFixed(0) + "px)");

  // Score popup
  const score = document.createElement("div");
  score.className = "shark-score";
  score.style.left = shark.x + "px";
  score.style.top = shark.y + "px";
  const messages = ["Got \u2018em!", "BOOM!", "Nice shot!", "Sushi time!", "Begone!", "K.O.!"];
  score.textContent = messages[Math.floor(Math.random() * messages.length)];
  document.body.appendChild(score);
  setTimeout(() => score.remove(), 1200);

  // Burst of bubbles at shark position
  for (let i = 0; i < 12; i++) {
    setTimeout(() => {
      const bub = document.createElement("div");
      bub.className = "fish-bub";
      bub.style.position = "fixed";
      bub.style.left = (shark.x + 20 + Math.random() * 40) + "px";
      bub.style.top = (shark.y + 10 + Math.random() * 20) + "px";
      const size = 4 + Math.random() * 8;
      bub.style.width = size + "px";
      bub.style.height = size + "px";
      bub.style.setProperty("--bx", "0px");
      bub.style.setProperty("--by", "0px");
      bub.style.setProperty("--drift", (Math.random() - 0.5) * 50 + "px");
      bub.style.setProperty("--dur", (1 + Math.random()) + "s");
      document.body.appendChild(bub);
      setTimeout(() => bub.remove(), 2000);
    }, i * 50);
  }

  // Remove shark after animation
  setTimeout(() => {
    if (shark.el) shark.el.remove();
    shark.el = null;
  }, 800);

  // End panic
  endSharkPanic();

  // Bubbles does a victory spin
  if (fish.el) {
    fish.el.classList.add("trick-spin");
    setTimeout(() => fish.el.classList.remove("trick-spin"), 700);
  }

  // Schedule next shark
  scheduleShark();
}

function sharkRetreat() {
  if (!shark.el || !shark.active) return;
  shark.active = false;
  cancelAnimationFrame(shark.frame);

  // Swim away
  const retreatX = shark.x > window.innerWidth / 2 ? window.innerWidth + 120 : -120;
  const startX = shark.x;
  const startY = shark.y;
  const start = Date.now();

  function retreatMove() {
    const t = Math.min(1, (Date.now() - start) / 2000);
    const x = startX + (retreatX - startX) * t;
    const scaleX = retreatX > startX ? 1 : -1;
    shark.el.style.transform = "translate(" + x.toFixed(0) + "px," + startY + "px) scaleX(" + scaleX + ")";
    if (t < 1) {
      requestAnimationFrame(retreatMove);
    } else {
      shark.el.remove();
      shark.el = null;
      scheduleShark();
    }
  }
  requestAnimationFrame(retreatMove);
  endSharkPanic();
}

function endSharkPanic() {
  if (fish.el) {
    fish.el.classList.remove("panicking");
    const exclaim = fish.el.querySelector(".fish-exclaim");
    if (exclaim) exclaim.remove();
    fish.speed = 1.2;
  }
  if (buddy.el) {
    buddy.el.classList.remove("panicking");
    buddy.speed = 0.8;
  }
}

// Shark is spawned from DOMContentLoaded

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
