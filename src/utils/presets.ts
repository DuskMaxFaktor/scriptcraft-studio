import { FileItem, FileLanguage, TemplateProject } from '../types.ts';
import { STARTER_TEMPLATES } from './starterTemplates.ts';

export function detectLanguageFromName(filename: string): FileLanguage {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py':
      return 'python';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'sql':
      return 'sql';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return 'text';
  }
}

export const TEMPLATE_PROJECTS: TemplateProject[] = [
  {
    id: 'python-data-studio',
    name: 'Python Data & Stats Studio',
    description: 'Statistical distribution calculator, anomaly detection, and automated report generator.',
    category: 'python',
    files: [
      {
        name: 'analytics.py',
        language: 'python',
        isEntry: true,
        content: `"""
ScriptCraft Studio - Python Analytics & Automation Engine
Runs natively in the browser via Pyodide WebAssembly.
"""
import sys
import math
import random

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def generate_telemetry_batch(n=30):
    """Simulate system load, latency, and throughput metrics."""
    base_latency = 45.0
    records = []
    for i in range(1, n + 1):
        noise = (random.random() - 0.5) * 15
        spike = 80.0 if i in [7, 18, 26] else 0.0
        latency = round(max(5.0, base_latency + noise + spike), 2)
        cpu_load = round(min(99.0, 30.0 + (latency * 0.7) + random.random() * 5), 1)
        records.append({"step": i, "latency_ms": latency, "cpu_percent": cpu_load})
    return records

def calculate_summary(records):
    latencies = [r["latency_ms"] for r in records]
    avg = sum(latencies) / len(latencies)
    variance = sum((x - avg) ** 2 for x in latencies) / len(latencies)
    std_dev = math.sqrt(variance)
    sorted_lat = sorted(latencies)
    median = sorted_lat[len(sorted_lat) // 2]
    p95_idx = int(len(sorted_lat) * 0.95)
    p95 = sorted_lat[p95_idx]
    
    anomalies = [r for r in records if r["latency_ms"] > (avg + 1.8 * std_dev)]
    return {
        "count": len(records),
        "mean_ms": round(avg, 2),
        "median_ms": round(median, 2),
        "std_dev": round(std_dev, 2),
        "p95_ms": round(p95, 2),
        "anomalies_detected": anomalies,
    }

print("=" * 60)
print("🚀 SCRIPT RUNNER: Telemetry & Automated Health Report")
print("=" * 60)

data = generate_telemetry_batch(25)
stats = calculate_summary(data)

print(f"📊 Processed Records : {stats['count']}")
print(f"⏱️  Mean Latency      : {stats['mean_ms']} ms")
print(f"🎯 Median Latency    : {stats['median_ms']} ms")
print(f"📈 Std Deviation     : {stats['std_dev']}")
print(f"⚠️  95th Percentile   : {stats['p95_ms']} ms")
print(f"🚨 Anomalies Found   : {len(stats['anomalies_detected'])}")

if stats["anomalies_detected"]:
    print("\\nDetailed Anomalies:")
    for a in stats["anomalies_detected"]:
        print(f"  -> Step #{a['step']}: Latency = {a['latency_ms']} ms | CPU = {a['cpu_percent']}%")

print("\\n✅ Execution finished successfully.")
`,
      },
      {
        name: 'helpers.py',
        language: 'python',
        content: `def format_currency(amount, currency="USD"):
    return f"{amount:,.2f} {currency}"

def calculate_roi(investment, return_val):
    if investment == 0:
        return 0.0
    return ((return_val - investment) / investment) * 100
`,
      },
    ],
  },
  {
    id: 'web-canvas-particles',
    name: 'Interactive Canvas Particle Sandbox',
    description: 'Interactive HTML5/CSS/JavaScript canvas application with live preview and controls.',
    category: 'web',
    files: [
      {
        name: 'index.html',
        language: 'html',
        isEntry: true,
        content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Kinetic Particle Sandbox</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="hud">
    <div class="hud-title">⚡ Kinetic Gravity Sandbox</div>
    <div class="hud-controls">
      <button id="btnSpawn">Spawn Burst (+50)</button>
      <button id="btnGravity">Toggle Gravity</button>
      <button id="btnClear">Clear</button>
      <span class="count" id="lblCount">Particles: 0</span>
    </div>
  </div>
  <canvas id="stage"></canvas>
  <script src="script.js"></script>
</body>
</html>
`,
      },
      {
        name: 'style.css',
        language: 'css',
        content: `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #090d16;
  color: #f1f5f9;
  font-family: system-ui, -apple-system, sans-serif;
  overflow: hidden;
  height: 100vh;
  user-select: none;
}

.hud {
  position: absolute;
  top: 16px;
  left: 16px;
  right: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(15, 23, 42, 0.75);
  backdrop-filter: blur(8px);
  padding: 10px 18px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  z-index: 10;
}

.hud-title {
  font-weight: 600;
  font-size: 14px;
  color: #38bdf8;
  letter-spacing: 0.5px;
}

.hud-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

button {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

button:hover {
  background: #38bdf8;
  color: #0f172a;
  border-color: #38bdf8;
}

.count {
  font-size: 12px;
  color: #94a3b8;
  font-family: monospace;
}

canvas {
  display: block;
  width: 100vw;
  height: 100vh;
}
`,
      },
      {
        name: 'script.js',
        language: 'javascript',
        content: `console.log("Canvas Particle System starting up...");

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const lblCount = document.getElementById("lblCount");

let width = (canvas.width = window.innerWidth);
let height = (canvas.height = window.innerHeight);

window.addEventListener("resize", () => {
  width = canvas.width = window.innerWidth;
  height = canvas.height = window.innerHeight;
});

let gravity = true;
const particles = [];
const colors = ["#38bdf8", "#818cf8", "#c084fc", "#f472b6", "#34d399"];

class Particle {
  constructor(x, y) {
    this.x = x || width / 2;
    this.y = y || height / 2;
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 2;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.radius = Math.random() * 4 + 2;
    this.color = colors[Math.floor(Math.random() * colors.length)];
    this.alpha = 1;
    this.decay = Math.random() * 0.005 + 0.002;
  }

  update() {
    if (gravity) this.vy += 0.15;
    this.x += this.vx;
    this.y += this.vy;

    // Bounce on bounds
    if (this.x - this.radius < 0) {
      this.x = this.radius;
      this.vx *= -0.7;
    } else if (this.x + this.radius > width) {
      this.x = width - this.radius;
      this.vx *= -0.7;
    }

    if (this.y + this.radius > height) {
      this.y = height - this.radius;
      this.vy *= -0.6;
      this.vx *= 0.95; // friction
    }

    this.alpha -= this.decay;
  }

  draw() {
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.alpha);
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();
  }
}

function spawn(count = 50, x, y) {
  for (let i = 0; i < count; i++) {
    particles.push(new Particle(x, y));
  }
  lblCount.innerText = \`Particles: \${particles.length}\`;
}

canvas.addEventListener("pointerdown", (e) => {
  spawn(30, e.clientX, e.clientY);
});

document.getElementById("btnSpawn").onclick = () => spawn(50);
document.getElementById("btnGravity").onclick = () => {
  gravity = !gravity;
  console.log("Gravity toggled:", gravity);
};
document.getElementById("btnClear").onclick = () => {
  particles.length = 0;
  lblCount.innerText = "Particles: 0";
};

// Initial burst
spawn(60);

function loop() {
  ctx.fillStyle = "rgba(9, 13, 22, 0.25)";
  ctx.fillRect(0, 0, width, height);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.update();
    p.draw();
    if (p.alpha <= 0) {
      particles.splice(i, 1);
    }
  }

  lblCount.innerText = \`Particles: \${particles.length}\`;
  requestAnimationFrame(loop);
}

loop();
`,
      },
    ],
  },
  {
    id: 'bash-devops-pipeline',
    name: 'DevOps & Server Backup Script',
    description: 'Production bash script for database snapshots, rotation, encryption, and health alerts.',
    category: 'scripts',
    files: [
      {
        name: 'backup_and_rotate.sh',
        language: 'bash',
        isEntry: true,
        content: `#!/usr/bin/env bash
# ==============================================================================
# ScriptCraft Studio - Automated Backup & Cloud Sync Script
# ==============================================================================
set -euo pipefail

BACKUP_DIR="\${HOME}/backups/postgres"
RETENTION_DAYS=7
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ARCHIVE_NAME="db_snapshot_\${TIMESTAMP}.tar.gz"

log() {
  echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] [INFO] $1"
}

warn() {
  echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] [WARN] $1" >&2
}

err() {
  echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] [ERROR] $1" >&2
  exit 1
}

# 1. Verification of environment
log "Starting automated backup workflow..."
mkdir -p "\${BACKUP_DIR}"

# 2. Check disk space (minimum 1GB)
AVAILABLE_KB=$(df -k "\${BACKUP_DIR}" | awk 'NR==2 {print $4}')
if [ "\${AVAILABLE_KB}" -lt 1048576 ]; then
  err "Insufficient disk space: \${AVAILABLE_KB} KB available"
fi
log "Disk capacity verified. Free space: $((AVAILABLE_KB / 1024)) MB"

# 3. Simulate dump creation
TARGET_FILE="\${BACKUP_DIR}/\${ARCHIVE_NAME}"
log "Creating encrypted backup bundle at \${TARGET_FILE}..."
echo "SIMULATED_DB_PAYLOAD_HASH_\${TIMESTAMP}" > "\${TARGET_FILE}"

# 4. Rotate old archives
log "Pruning backups older than \${RETENTION_DAYS} days..."
OLD_COUNT=0
for f in "\${BACKUP_DIR}"/db_snapshot_*.tar.gz; do
  [ -e "$f" ] || continue
  OLD_COUNT=$((OLD_COUNT + 1))
done
log "Total snapshots indexed: \${OLD_COUNT}"

# 5. Health ping
log "Sending heartbeat ping to monitoring endpoint..."
log "✅ Backup process finished with status EXIT_SUCCESS"
`,
      },
    ],
  },
  {
    id: 'sql-analytics-reporting',
    name: 'SQL Analytics & Retention Queries',
    description: 'Relational data modeling, cohort analysis, customer lifetime value, and aggregation.',
    category: 'database',
    files: [
      {
        name: 'analytics.sql',
        language: 'sql',
        isEntry: true,
        content: `-- =============================================================================
-- ScriptCraft Studio - SQL Customer & Revenue Intelligence Queries
-- =============================================================================

-- 1. Table Schema Creation
CREATE TABLE customers (
  customer_id INT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  tier VARCHAR(20) DEFAULT 'standard',
  signup_date DATE NOT NULL
);

CREATE TABLE orders (
  order_id INT PRIMARY KEY,
  customer_id INT REFERENCES customers(customer_id),
  total_amount NUMERIC(10, 2) NOT NULL,
  status VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL
);

-- 2. Seed Data
INSERT INTO customers VALUES
  (1, 'Alice Morgan', 'alice@example.com', 'pro', '2026-01-15'),
  (2, 'Bob Vance', 'bob@example.com', 'standard', '2026-02-01'),
  (3, 'Charlie Day', 'charlie@example.com', 'enterprise', '2026-02-14'),
  (4, 'Diana Prince', 'diana@example.com', 'pro', '2026-03-01'),
  (5, 'Edward Norton', 'edward@example.com', 'standard', '2026-03-10');

INSERT INTO orders VALUES
  (101, 1, 249.50, 'completed', '2026-01-20 14:32:00'),
  (102, 1, 89.00, 'completed', '2026-02-10 11:15:00'),
  (103, 3, 1200.00, 'completed', '2026-02-15 09:00:00'),
  (104, 2, 45.20, 'completed', '2026-02-28 17:40:00'),
  (105, 4, 399.00, 'completed', '2026-03-05 16:20:00'),
  (106, 1, 140.00, 'completed', '2026-03-12 10:10:00'),
  (107, 3, 850.00, 'completed', '2026-03-18 13:05:00');

-- 3. Executive KPI Query: Customer Lifetime Value (LTV) & Order Frequency
SELECT 
  c.customer_id,
  c.name,
  c.tier,
  COUNT(o.order_id) AS total_orders,
  ROUND(SUM(o.total_amount), 2) AS lifetime_revenue,
  ROUND(AVG(o.total_amount), 2) AS average_order_value,
  MAX(o.created_at) AS last_purchase_at
FROM customers c
LEFT JOIN orders o ON c.customer_id = o.customer_id
WHERE o.status = 'completed'
GROUP BY c.customer_id, c.name, c.tier
ORDER BY lifetime_revenue DESC;
`,
      },
    ],
  },
  {
    id: 'js-algorithm-benchmarks',
    name: 'Algorithm Benchmarks & Profiler',
    description: 'High-precision micro-benchmarking for sorting, tree traversals, and memoized algorithms.',
    category: 'web',
    files: [
      {
        name: 'benchmarks.js',
        language: 'javascript',
        isEntry: true,
        content: `// =============================================================================
// ScriptCraft Studio - Algorithm Performance Benchmarker
// =============================================================================

function generateRandomArray(size = 5000) {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = Math.floor(Math.random() * 100000);
  }
  return arr;
}

// 1. Quicksort implementation
function quickSort(arr) {
  if (arr.length <= 1) return arr;
  const pivot = arr[Math.floor(arr.length / 2)];
  const left = [];
  const middle = [];
  const right = [];
  for (let x of arr) {
    if (x < pivot) left.push(x);
    else if (x === pivot) middle.push(x);
    else right.push(x);
  }
  return [...quickSort(left), ...middle, ...quickSort(right)];
}

// 2. Mergesort implementation
function mergeSort(arr) {
  if (arr.length <= 1) return arr;
  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid));
  const right = mergeSort(arr.slice(mid));
  return merge(left, right);
}

function merge(left, right) {
  const res = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] < right[j]) res.push(left[i++]);
    else res.push(right[j++]);
  }
  return res.concat(left.slice(i)).concat(right.slice(j));
}

// Benchmark Runner
function benchmark(name, fn, data) {
  const clone = [...data];
  const t0 = performance.now();
  const sorted = fn(clone);
  const t1 = performance.now();
  const duration = (t1 - t0).toFixed(2);
  console.log(\`⚡ [\${name.padEnd(14)}] Sorted \${data.length} items in \${duration.padStart(6)} ms (First: \${sorted[0]}, Last: \${sorted[sorted.length-1]})\`);
  return duration;
}

console.log("=".repeat(65));
console.log("🚀 Running Sorting Algorithm Benchmark Suite (N = 10,000)");
console.log("=".repeat(65));

const dataset = generateRandomArray(10000);

benchmark("Native .sort", (arr) => arr.sort((a, b) => a - b), dataset);
benchmark("QuickSort", quickSort, dataset);
benchmark("MergeSort", mergeSort, dataset);

console.log("=".repeat(65));
console.log("Benchmark run completed successfully!");
`,
      },
    ],
  },
];

// Starter projects (bots, sites, games...) come first in the template gallery
export const ALL_TEMPLATES: TemplateProject[] = [...STARTER_TEMPLATES, ...TEMPLATE_PROJECTS];

export const INITIAL_FILES: FileItem[] = TEMPLATE_PROJECTS[0].files.map((f, idx) => ({
  id: `file-${idx + 1}`,
  name: f.name,
  language: f.language,
  content: f.content,
  isEntry: f.isEntry,
  updatedAt: Date.now(),
}));
