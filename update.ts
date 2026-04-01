import fs from "fs";
import http from "http";
import path from "path";
import { retry } from "@octokit/plugin-retry";
import { Octokit } from "@octokit/rest";
import dayjs from "dayjs";

const MyOctokit = Octokit.plugin(retry);
const github = new MyOctokit({
  auth: process.env.GH_TOKEN,
  retry: { retries: 10, retryAfter: 15, doNotRetry: [400, 401, 404, 422, 451] },
});

const OWNER = "thegoodparty";
const REPOS = ["gp-webapp", "gp-api", "people-api", "election-api"];
const PUBLISH_OWNER = "swain";
const PUBLISH_REPO = "deploy-metrics";
const DAYS_BACK = 180;
const LOCAL_MODE = process.argv.includes("--local");
const DIST_DIR = path.join(__dirname, "dist");

interface PRMetric {
  repo: string;
  number: number;
  title: string;
  author: string;
  merged_to_develop_at: string;
  deployed_to_master_at: string | null;
  mttd_hours: number | null;
}

const run = async () => {
  const since = dayjs().subtract(DAYS_BACK, "day");
  const allPRs: PRMetric[] = [];

  for (const repo of REPOS) {
    console.log(`\nProcessing ${repo}...`);
    const metrics = await collectRepoMetrics(repo, since);
    allPRs.push(...metrics);
  }

  const weeklyAverages = computeWeeklyAverages(allPRs);

  const output = {
    generated_at: new Date().toISOString(),
    days_back: DAYS_BACK,
    prs: allPRs,
    weekly_averages: weeklyAverages,
  };

  const metricsJson = JSON.stringify(output, null, 2);

  const deployed = allPRs.filter((m) => m.mttd_hours !== null);
  const pending = allPRs.filter((m) => m.mttd_hours === null);
  const avgMTTD =
    deployed.length > 0
      ? deployed.reduce((sum, m) => sum + m.mttd_hours!, 0) / deployed.length
      : 0;

  console.log(`\n--- Summary ---`);
  console.log(`Deployed: ${deployed.length} PRs`);
  console.log(`Pending:  ${pending.length} PRs`);
  console.log(
    `Avg MTTD: ${(avgMTTD / 24).toFixed(1)} days (${avgMTTD.toFixed(1)} hrs)`,
  );

  if (LOCAL_MODE) {
    writeLocal(metricsJson);
  } else {
    await publishToGitHub(metricsJson);
  }
};

const writeLocal = (metricsJson: string) => {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, "metrics.json"), metricsJson);
  fs.writeFileSync(path.join(DIST_DIR, "index.html"), DASHBOARD_HTML);
  console.log(`\nWrote dist/metrics.json and dist/index.html`);

  const PORT = 3000;
  const MIME: Record<string, string> = {
    ".html": "text/html",
    ".json": "application/json",
  };
  http
    .createServer((req, res) => {
      const file = req.url === "/" ? "/index.html" : req.url!;
      const filePath = path.join(DIST_DIR, file);
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type":
            MIME[path.extname(file)] || "application/octet-stream",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    })
    .listen(PORT, () => {
      console.log(`Serving at http://localhost:${PORT}`);
    });
};

const publishToGitHub = async (metricsJson: string) => {
  const files = [
    { path: "metrics.json", content: metricsJson },
    { path: "index.html", content: DASHBOARD_HTML },
  ];

  for (const file of files) {
    let sha: string | undefined;
    try {
      const existing = await github.repos.getContent({
        owner: PUBLISH_OWNER,
        repo: PUBLISH_REPO,
        path: file.path,
      });
      if (!Array.isArray(existing.data) && "sha" in existing.data) {
        sha = existing.data.sha;
      }
    } catch {}

    await github.repos.createOrUpdateFileContents({
      owner: PUBLISH_OWNER,
      repo: PUBLISH_REPO,
      path: file.path,
      message: `Update ${file.path}`,
      content: Buffer.from(file.content).toString("base64"),
      sha,
    });
    console.log(`  Published ${file.path}`);
  }

  console.log(
    `\nDashboard: https://${PUBLISH_OWNER}.github.io/${PUBLISH_REPO}/`,
  );
};

const collectRepoMetrics = async (
  repo: string,
  since: dayjs.Dayjs,
): Promise<PRMetric[]> => {
  const mergedPRs = await fetchMergedPRs(repo, "develop", since);
  console.log(`  ${mergedPRs.length} PRs merged to develop`);

  const deployPRs = (
    await fetchMergedPRs(repo, "master", since.subtract(30, "day"))
  ).sort(
    (a, b) =>
      new Date(a.merged_at!).getTime() - new Date(b.merged_at!).getTime(),
  );
  console.log(`  ${deployPRs.length} PRs merged to master (deploy events)`);

  const masterCommits = await github.paginate(github.repos.listCommits, {
    owner: OWNER,
    repo,
    sha: "master",
    since: since.subtract(30, "day").toISOString(),
    per_page: 100,
  });
  const masterSHAs = new Set(masterCommits.map((c) => c.sha));

  const metrics: PRMetric[] = [];

  for (const pr of mergedPRs) {
    const isDeployed =
      pr.merge_commit_sha && masterSHAs.has(pr.merge_commit_sha);
    let deployedAt: string | null = null;
    let mttdHours: number | null = null;

    if (isDeployed) {
      const prMergedTime = new Date(pr.merged_at!).getTime();
      const deploy = deployPRs.find(
        (d) => new Date(d.merged_at!).getTime() >= prMergedTime,
      );

      if (deploy?.merged_at) {
        deployedAt = deploy.merged_at;
        mttdHours =
          (new Date(deployedAt).getTime() - prMergedTime) / (1000 * 60 * 60);
        if (mttdHours < 0) mttdHours = 0;
      }
    }

    metrics.push({
      repo,
      number: pr.number,
      title: pr.title,
      author: pr.user?.login || "unknown",
      merged_to_develop_at: pr.merged_at!,
      deployed_to_master_at: deployedAt,
      mttd_hours: mttdHours,
    });
  }

  return metrics;
};

const fetchMergedPRs = async (
  repo: string,
  base: string,
  since: dayjs.Dayjs,
) => {
  const mergedPRs: Awaited<ReturnType<typeof github.pulls.list>>["data"] = [];
  let page = 1;

  while (true) {
    const { data } = await github.pulls.list({
      owner: OWNER,
      repo,
      state: "closed",
      base,
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    mergedPRs.push(
      ...data.filter(
        (pr) => pr.merged_at && dayjs(pr.merged_at).isAfter(since),
      ),
    );

    const oldestUpdate = dayjs(data[data.length - 1].updated_at);
    if (oldestUpdate.isBefore(since)) break;

    page++;
  }

  return mergedPRs;
};

const computeWeeklyAverages = (prs: PRMetric[]) => {
  const deployed = prs.filter((pr) => pr.mttd_hours !== null);

  const byWeek = new Map<string, PRMetric[]>();
  for (const pr of deployed) {
    const weekStart = getWeekStart(pr.merged_to_develop_at);
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart)!.push(pr);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, weekPRs]) => {
      const allHours = weekPRs.map((pr) => pr.mttd_hours!);

      const byRepo: Record<
        string,
        { mean_hours: number; median_hours: number; count: number }
      > = {};
      for (const repo of REPOS) {
        const repoPRs = weekPRs.filter((pr) => pr.repo === repo);
        if (repoPRs.length === 0) continue;
        const hours = repoPRs.map((pr) => pr.mttd_hours!);
        byRepo[repo] = {
          mean_hours: round(mean(hours)),
          median_hours: round(median(hours)),
          count: hours.length,
        };
      }

      return {
        week_start: weekStart,
        all_repos: {
          mean_hours: round(mean(allHours)),
          median_hours: round(median(allHours)),
          count: allHours.length,
        },
        by_repo: byRepo,
      };
    });
};

const getWeekStart = (date: string) => {
  const d = dayjs(date);
  const day = d.day() || 7;
  return d.subtract(day - 1, "day").format("YYYY-MM-DD");
};

const mean = (arr: number[]) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
const median = (arr: number[]) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (n: number) => Math.round(n * 10) / 10;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Time To Deploy Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 4px; color: #f0f6fc; }
  .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
  .description { color: #c9d1d9; font-size: 14px; line-height: 1.6; margin-bottom: 32px; max-width: 720px; }
  .stats { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; min-width: 200px; }
  .stat-card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .stat-card .value { font-size: 32px; font-weight: 700; color: #f0f6fc; }
  .stat-card .unit { font-size: 14px; color: #8b949e; }
  .stat-card .trend { font-size: 14px; margin-top: 4px; }
  .trend.down { color: #3fb950; }
  .trend.up { color: #f85149; }
  .trend.flat { color: #8b949e; }
  .chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; margin-bottom: 32px; }
  .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .chart-title { font-size: 16px; font-weight: 600; color: #f0f6fc; }
  .range-btns { display: flex; gap: 4px; }
  .range-btn { padding: 5px 12px; border-radius: 6px; border: 1px solid #30363d; background: transparent; color: #8b949e; cursor: pointer; font-size: 13px; }
  .range-btn.active { background: #21262d; color: #f0f6fc; border-color: #58a6ff; }
  .range-btn:hover { border-color: #58a6ff; }
  details { margin-bottom: 32px; }
  summary { font-size: 16px; font-weight: 600; color: #8b949e; cursor: pointer; padding: 12px 0; }
  summary:hover { color: #f0f6fc; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; margin-top: 12px; }
  th { text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; border-bottom: 1px solid #30363d; background: #161b22; position: sticky; top: 0; }
  td { padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #21262d; }
  tr:last-child td { border-bottom: none; }
  .pending { color: #8b949e; font-style: italic; }
</style>
</head>
<body>
<h1>Time to Deploy</h1>
<p class="subtitle" id="subtitle">Loading...</p>
<p class="description">
  <strong>TTD (Time to Deploy)</strong> measures how long it takes for a pull request to go from being merged into <code>develop</code> to being deployed to production via <code>master</code>.
  This tracks the full promotion cycle across all repositories: develop &rarr; qa &rarr; master.
  The chart shows a 4-week rolling average to smooth out weekly variation from weekends and release cadence.
</p>

<div class="stats" id="stats"></div>

<div class="chart-container">
  <div class="chart-header">
    <div class="chart-title">TTD Over Time (4-week rolling avg, hours)</div>
    <div class="range-btns" id="range-btns">
      <button class="range-btn" data-days="30">30d</button>
      <button class="range-btn" data-days="60">60d</button>
      <button class="range-btn active" data-days="90">90d</button>
      <button class="range-btn" data-days="180">180d</button>
    </div>
  </div>
  <canvas id="chart" height="100"></canvas>
</div>

<details>
  <summary>PR Details</summary>
  <table>
    <thead><tr><th>Repo</th><th>PR</th><th>Author</th><th>Merged to develop</th><th>Deployed to master</th><th>TTD</th></tr></thead>
    <tbody id="pr-table"></tbody>
  </table>
</details>

<script>
let chart = null
let allData = null

const formatDuration = (hours) => {
  if (hours === null || isNaN(hours)) return '-'
  return Math.round(hours) + 'h'
}

const rollingAvg = (arr, window) => {
  return arr.map((_, i) => {
    const start = Math.max(0, i - window + 1)
    const slice = arr.slice(start, i + 1).filter(v => v !== null)
    return slice.length > 0 ? Math.round(slice.reduce((s, v) => s + v, 0) / slice.length * 10) / 10 : null
  })
}

fetch('metrics.json')
  .then(r => r.json())
  .then(data => {
    allData = data
    document.getElementById('subtitle').textContent =
      'Last updated: ' + new Date(data.generated_at).toLocaleString()
    renderAll(90)
    document.getElementById('range-btns').addEventListener('click', e => {
      const btn = e.target.closest('.range-btn')
      if (!btn) return
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      renderAll(parseInt(btn.dataset.days))
    })
  })

function renderAll(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const filteredPRs = allData.prs.filter(p => p.merged_to_develop_at >= cutoff)
  const filteredWeeks = allData.weekly_averages.filter(w => w.week_start >= cutoff.slice(0, 10))
  renderStats(filteredPRs, filteredWeeks)
  renderChart(filteredWeeks, cutoff.slice(0, 10))
  renderTable(filteredPRs)
}

function renderStats(prs, weeks) {
  const deployed = prs.filter(p => p.mttd_hours !== null)
  const pending = prs.filter(p => p.mttd_hours === null)
  const avgHours = deployed.length > 0
    ? deployed.reduce((s, p) => s + p.mttd_hours, 0) / deployed.length
    : null
  const medianHours = deployed.length > 0
    ? (() => {
        const sorted = deployed.map(p => p.mttd_hours).sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
      })()
    : null

  const trendHtml = (first, last) => {
    if (first === null || last === null || first === 0) return ''
    const pct = Math.round((last - first) / first * 100)
    const cls = pct < 0 ? 'down' : pct > 0 ? 'up' : 'flat'
    const arrow = pct < 0 ? 'v ' : pct > 0 ? '^ ' : '~ '
    return '<div class="trend ' + cls + '">' + arrow + Math.abs(pct) + '% over interval</div>'
  }

  const firstWeek = weeks.length > 0 ? weeks[0].all_repos : null
  const lastWeek = weeks.length > 0 ? weeks[weeks.length - 1].all_repos : null

  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="label">Mean TTD</div>' +
    '<div class="value">' + formatDuration(avgHours) + '</div>' +
    (firstWeek && lastWeek ? trendHtml(firstWeek.mean_hours, lastWeek.mean_hours) : '') + '</div>' +
    '<div class="stat-card"><div class="label">Median TTD</div>' +
    '<div class="value">' + formatDuration(medianHours) + '</div>' +
    (firstWeek && lastWeek ? trendHtml(firstWeek.median_hours, lastWeek.median_hours) : '') + '</div>' +
    '<div class="stat-card"><div class="label">PRs Measured</div>' +
    '<div class="value">' + deployed.length + '</div>' +
    '<div class="unit">' + pending.length + ' pending</div></div>'
}

function renderChart(weeks, cutoff) {
  const allWeeks = allData.weekly_averages
  const allMean = rollingAvg(allWeeks.map(w => w.all_repos.mean_hours), 4)
  const allMedian = rollingAvg(allWeeks.map(w => w.all_repos.median_hours), 4)
  const startIdx = allWeeks.findIndex(w => w.week_start >= cutoff)
  const labels = allWeeks.slice(startIdx).map(w => w.week_start)
  const meanData = allMean.slice(startIdx)
  const medianData = allMedian.slice(startIdx)

  const datasets = [{
    label: 'Mean (4-wk rolling)',
    data: meanData,
    borderColor: '#58a6ff',
    backgroundColor: 'rgba(88,166,255,0.1)',
    borderWidth: 2,
    tension: 0.3,
    fill: true,
    pointRadius: 3,
  }, {
    label: 'Median (4-wk rolling)',
    data: medianData,
    borderColor: '#3fb950',
    borderWidth: 2,
    tension: 0.3,
    pointRadius: 3,
    borderDash: [5, 3],
  }]

  if (chart) {
    chart.data.labels = labels
    chart.data.datasets = datasets
    chart.update()
    return
  }

  chart = new Chart(document.getElementById('chart').getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { color: '#21262d' },
          ticks: { color: '#8b949e' },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#21262d' },
          ticks: { color: '#8b949e', callback: v => v + 'h' },
          title: { display: true, text: 'Hours', color: '#8b949e' },
        },
      },
      plugins: {
        legend: { labels: { color: '#c9d1d9' } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + 'h',
          },
        },
      },
    },
  })
}

function renderTable(prs) {
  const sorted = [...prs].sort((a, b) =>
    new Date(b.merged_to_develop_at).getTime() - new Date(a.merged_to_develop_at).getTime()
  )
  const formatDate = (iso) => {
    if (!iso) return '<span class="pending">pending</span>'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  }
  document.getElementById('pr-table').innerHTML = sorted
    .map(pr =>
      '<tr>' +
      '<td>' + pr.repo + '</td>' +
      '<td><a href="https://github.com/thegoodparty/' + pr.repo + '/pull/' + pr.number +
        '" target="_blank" style="color:#58a6ff;text-decoration:none">#' + pr.number + '</a> ' + pr.title + '</td>' +
      '<td>' + pr.author + '</td>' +
      '<td>' + formatDate(pr.merged_to_develop_at) + '</td>' +
      '<td>' + formatDate(pr.deployed_to_master_at) + '</td>' +
      '<td>' + formatDuration(pr.mttd_hours) + '</td>' +
      '</tr>'
    )
    .join('')
}
</script>
</body>
</html>`;

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
