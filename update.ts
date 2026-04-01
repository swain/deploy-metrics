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

  await publishToGitHub(metricsJson);
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
  .compare-banner { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; display: none; align-items: center; gap: 16px; flex-wrap: wrap; }
  .compare-banner.visible { display: flex; }
  .compare-banner .compare-label { font-size: 13px; color: #8b949e; }
  .compare-banner .compare-value { font-size: 18px; font-weight: 700; }
  .compare-banner .compare-value.improved { color: #3fb950; }
  .compare-banner .compare-value.regressed { color: #f85149; }
  .compare-banner .compare-value.neutral { color: #8b949e; }
  .compare-banner .compare-reset { margin-left: auto; padding: 4px 12px; border-radius: 6px; border: 1px solid #30363d; background: transparent; color: #8b949e; cursor: pointer; font-size: 12px; }
  .compare-banner .compare-reset:hover { border-color: #58a6ff; color: #f0f6fc; }
  .compare-hint { font-size: 12px; color: #484f58; margin-top: 8px; }
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

<div id="compare-banner" class="compare-banner"></div>

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
  <div class="compare-hint">Click two points on the chart to compare</div>
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
let comparePoints = []
let currentWeeks = []

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
  currentWeeks = filteredWeeks
  comparePoints = []
  renderCompare()
  renderStats(filteredPRs, filteredWeeks)
  renderChart(filteredWeeks)
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

  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="label">Mean TTD</div>' +
    '<div class="value">' + formatDuration(avgHours) + '</div></div>' +
    '<div class="stat-card"><div class="label">Median TTD</div>' +
    '<div class="value">' + formatDuration(medianHours) + '</div></div>' +
    '<div class="stat-card"><div class="label">PRs Measured</div>' +
    '<div class="value">' + deployed.length + '</div>' +
    '<div class="unit">' + pending.length + ' pending</div></div>'
}

function renderChart(weeks) {
  const labels = weeks.map(w => w.week_start)
  const rawMean = weeks.map(w => w.all_repos.mean_hours)
  const rawMedian = weeks.map(w => w.all_repos.median_hours)

  const datasets = [{
    label: 'Mean (4-wk rolling)',
    data: rollingAvg(rawMean, 4),
    borderColor: '#58a6ff',
    backgroundColor: 'rgba(88,166,255,0.1)',
    borderWidth: 2,
    tension: 0.3,
    fill: true,
    pointRadius: 3,
  }, {
    label: 'Median (4-wk rolling)',
    data: rollingAvg(rawMedian, 4),
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
      onClick: (evt, elements) => {
        if (!elements.length) return
        const idx = elements[0].index
        if (comparePoints.length === 0) {
          comparePoints = [idx]
        } else if (comparePoints.length === 1) {
          if (idx === comparePoints[0]) return
          comparePoints = [comparePoints[0], idx].sort((a, b) => a - b)
        } else {
          comparePoints = [idx]
        }
        renderCompare()
      },
    },
  })
}

function renderCompare() {
  const banner = document.getElementById('compare-banner')
  if (comparePoints.length < 2) {
    if (comparePoints.length === 1) {
      banner.innerHTML = '<span class="compare-label">Selected: week of ' + currentWeeks[comparePoints[0]].week_start + ' — click another point to compare</span>' +
        '<button class="compare-reset" onclick="comparePoints=[];renderCompare()">Clear</button>'
      banner.classList.add('visible')
    } else {
      banner.classList.remove('visible')
    }
    return
  }

  const a = currentWeeks[comparePoints[0]].all_repos
  const b = currentWeeks[comparePoints[1]].all_repos
  const meanPct = a.mean_hours > 0 ? Math.round((b.mean_hours - a.mean_hours) / a.mean_hours * 100) : 0
  const medianPct = a.median_hours > 0 ? Math.round((b.median_hours - a.median_hours) / a.median_hours * 100) : 0
  const meanCls = meanPct < 0 ? 'improved' : meanPct > 0 ? 'regressed' : 'neutral'
  const medianCls = medianPct < 0 ? 'improved' : medianPct > 0 ? 'regressed' : 'neutral'
  const sign = (v) => v > 0 ? '+' : ''

  banner.innerHTML =
    '<span class="compare-label">' + currentWeeks[comparePoints[0]].week_start + ' vs ' + currentWeeks[comparePoints[1]].week_start + '</span>' +
    '<div><span class="compare-label">Mean</span> <span class="compare-value ' + meanCls + '">' + sign(meanPct) + meanPct + '%</span></div>' +
    '<div><span class="compare-label">Median</span> <span class="compare-value ' + medianCls + '">' + sign(medianPct) + medianPct + '%</span></div>' +
    '<button class="compare-reset" onclick="comparePoints=[];renderCompare()">Clear</button>'
  banner.classList.add('visible')
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
