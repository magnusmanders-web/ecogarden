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

  // Fish buddy (desktop only) — delay so page renders first
  setTimeout(initFish, 2500);
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
  } else if (fish.el) {
    fishFrame = requestAnimationFrame(fishLoop);
    if (!fish.moving) fishPickTarget();
    scheduleTip();
  }
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
