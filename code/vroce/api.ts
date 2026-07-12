import type {
  TodayStatus, Last7, AnnualTrendRow, AnnualTrend, SiteMeta,
  SeasonHeatmapRow, RegressionResult, RegressionResponse, DailyWindowRow,
} from "./types.ts";

// ERA5 Datasette — same-origin; override with VITE_DATASETTE_URL for dev
const DS = `${import.meta.env.VITE_DATASETTE_URL ?? ""}/datasette/climate-si`;
// ARSO historical data — stage-data.podnebnik.org has CORS open to all origins
const SD = "https://stage-data.podnebnik.org/temperature";
// Vremenar live proxy — same-origin; override with VITE_VREMENAR_URL for dev
const VR = `${import.meta.env.VITE_VREMENAR_URL ?? ""}/vremenar/staging`;

// Populated during fetchMeta() from climate-si stations table
let vremenarIdMap: Record<string, number> = {};

export function isArsoLoc(loc: string): boolean {
  return loc.startsWith("arso:");
}

function arsoStationId(loc: string): number {
  return Number(loc.replace("arso:", ""));
}

// For ARSO percentiles: table covers 2025-07-01 → 2026-06-30
function arsoPercentileDate(month: number, day: number): string {
  const year = month >= 7 ? 2025 : 2026;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const CAT_COLORS: Record<string, string> = {
  hell:     "#962c1a",
  hot:      "#c25a2c",
  nope:     "#e7d9b8",
  cold:     "#6c8fb6",
  freezing: "#3a5a8a",
};

const VAR_LABELS: Record<string, string> = {
  temperature_max:  "Max temperature (°C)",
  temperature_min:  "Min temperature (°C)",
  temperature_mean: "Mean temperature (°C)",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

async function dsGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${DS}/${path}`);
  if (!resp.ok) throw new Error(`Datasette ${resp.status}: ${path}`);
  return resp.json() as Promise<T>;
}

async function sdGet(table: string, params: string): Promise<any> {
  const encoded = table.replace(/\./g, "~2E");
  const resp = await fetch(`${SD}/${encoded}.json?_shape=array&${params}`);
  if (!resp.ok) throw new Error(`stage-data ${resp.status}: ${table}`);
  return resp.json();
}

function doyToMonthDay(doy: number): { month: number; day: number } {
  const d = new Date(Date.UTC(2001, 0, 1));
  d.setUTCDate(d.getUTCDate() + doy - 1);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function monthDayToDoy(month: number, day: number): number {
  const DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return DAYS[month - 1] + day;
}

// Generate approximate normal distribution from known percentile values.
// Temperature data is roughly normal; this gives DistributionChart a curve to draw.
function syntheticDistribution(p05: number, p50: number, p95: number): [number, number][] {
  const sigma = Math.max((p95 - p05) / 3.29, 0.5); // 90-pct span ÷ 3.29σ
  const mu    = p50;
  const lo    = mu - 4 * sigma;
  const hi    = mu + 4 * sigma;
  const norm  = 1 / (sigma * Math.sqrt(2 * Math.PI));
  const pts: [number, number][] = [];
  for (let i = 0; i <= 60; i++) {
    const x = lo + (hi - lo) * i / 60;
    const y = norm * Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    pts.push([parseFloat(x.toFixed(2)), parseFloat(y.toFixed(6))]);
  }
  return pts;
}

function dateToMonthDay(dateStr: string): { month: number; day: number } {
  const [, m, d] = dateStr.split("-");
  return { month: Number(m), day: Number(d) };
}

function dayLabel(month: number, day: number): string {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${MONTHS[month - 1]} ${day}`;
}

function categorizeEra5(temp: number, w: DailyWindowRow): { category_key: string; percentile: number; color: string } {
  if (temp >= w.p95) return { category_key: "hell",     percentile: 97.5, color: CAT_COLORS.hell     };
  if (temp >= w.p80) return { category_key: "hot",      percentile: 87.5, color: CAT_COLORS.hot      };
  if (temp >= w.p20) return { category_key: "nope",     percentile: 50,   color: CAT_COLORS.nope     };
  if (temp >= w.p10) return { category_key: "cold",     percentile: 15,   color: CAT_COLORS.cold     };
  return                    { category_key: "freezing", percentile:  5,   color: CAT_COLORS.freezing };
}

interface ArsoPercentileRow {
  p05: number; p20: number; p50: number; p80: number; p95: number;
}

function categorizeArso(temp: number, p: ArsoPercentileRow): { category_key: string; percentile: number; color: string } {
  if (temp >= p.p95) return { category_key: "hell",     percentile: 97.5, color: CAT_COLORS.hell     };
  if (temp >= p.p80) return { category_key: "hot",      percentile: 87.5, color: CAT_COLORS.hot      };
  if (temp >= p.p20) return { category_key: "nope",     percentile: 50,   color: CAT_COLORS.nope     };
  if (temp >= p.p05) return { category_key: "cold",     percentile: 15,   color: CAT_COLORS.cold     };
  return                    { category_key: "freezing", percentile:  5,   color: CAT_COLORS.freezing };
}

async function fetchEra5WindowRow(era5Name: string, month: number, day: number): Promise<DailyWindowRow | null> {
  const rows = await dsGet<DailyWindowRow[]>(
    `daily_window.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&month__exact=${month}&day__exact=${day}`
  );
  return rows[0] ?? null;
}

async function fetchArsoPercentileRow(stationId: number, month: number, day: number): Promise<ArsoPercentileRow | null> {
  const date = arsoPercentileDate(month, day);
  // stage-data returns array rows: [rowid, station_id, date, p00, p05, p20, p40, p50, p60, p80, p95, p100]
  const data = await sdGet(
    "temperature.slovenia_historical.daily.average_percentiles",
    `station_id__exact=${stationId}&date__exact=${date}&_col=p05&_col=p20&_col=p50&_col=p80&_col=p95`
  );
  if (!Array.isArray(data) || !data[0]) return null;
  const r = data[0] as { p05: number; p20: number; p50: number; p80: number; p95: number };
  return { p05: r.p05, p20: r.p20, p50: r.p50, p80: r.p80, p95: r.p95 };
}

async function vremenarTemp(stationId: number): Promise<number | null> {
  try {
    const resp = await fetch(`${VR}/stations/details/METEO-${stationId}?country=si`);
    if (!resp.ok) return null;
    const data = await resp.json() as { statistics?: { temperature_max_24h?: number } };
    return data?.statistics?.temperature_max_24h ?? null;
  } catch {
    return null;
  }
}

// ── fetchMeta ──────────────────────────────────────────────────────────────────

export async function fetchMeta(): Promise<SiteMeta> {
  const [era5Stations, arsoRaw] = await Promise.all([
    dsGet<Array<{
      era5_name: string; name: string; lat: number; lon: number;
      elevation: number; station_id: number | null;
    }>>("stations.json?_shape=array&_col=era5_name&_col=name&_col=lat&_col=lon&_col=elevation&_col=station_id&_size=30"),
    sdGet("temperature.slovenia_stations", "_col=station_id&_col=name&_col=name_locative&_sort=name&_size=50"),
  ]);

  // Build Vremenar live-data map from ERA5 stations
  vremenarIdMap = Object.fromEntries(
    era5Stations
      .filter(s => s.station_id != null)
      .map(s => [s.era5_name, s.station_id as number])
  );

  // ARSO stations — need lat/lon from Vremenar or hardcode; use null for now
  // stage-data stations table: [rowid, station_id, name, name_locative]
  type ArsoRow = { station_id: number; name: string; name_locative: string };
  const arsoStations: ArsoRow[] = Array.isArray(arsoRaw) ? arsoRaw : [];

  const stations = [
    ...era5Stations.map(s => ({
      name:      s.era5_name,
      label:     s.name,
      source:    "era5" as const,
      lat:       s.lat,
      lon:       s.lon,
      elevation: s.elevation,
    })),
    ...arsoStations.map(s => ({
      name:      `arso:${s.station_id}`,
      label:     s.name,
      source:    "arso" as const,
      lat:       0,
      lon:       0,
      elevation: 0,
    })),
  ];

  return {
    country:          "si",
    name:             "Slovenija",
    default_location: "Ljubljana",
    languages:        ["en"],
    default_language: "en",
    features: {
      regression_chart:      true,
      trend_calendar:        true,
      station_map:           true,
      hero_cards:            false,
      spei_heatmap:          false,
      drought_trend_chart:   false,
      tropical_days_chart:   false,
      tropical_nights_chart: false,
      sea_level_section:     false,
    },
    map:      { center_lat: 46.1, center_lon: 14.8, zoom: 7 },
    branding: { site_title: "Podnebnik · Ali je vroče?", domain: "podnebnik.kesma.wtf" },
    stations,
    strings: {
      explain_reg: "Theil-Sen regresija + Yue-Wang TFPW Mann-Kendall test · ERA5-Land · nadmorska korekcija",
      explain_cal: "Trend na desetletje za vsak dan v letu · rdeča = ogrevanje · modra = ohlajanje · prosojnost = statistična značilnost",
    },
  };
}

// ── fetchTodayStatus ───────────────────────────────────────────────────────────

export async function fetchTodayStatus(date: string, loc: string | null): Promise<TodayStatus> {
  const era5Name = loc ?? "Ljubljana";
  const { month, day } = dateToMonthDay(date);

  if (isArsoLoc(era5Name)) {
    const stationId = arsoStationId(era5Name);
    const [todayTemp, perc] = await Promise.all([
      vremenarTemp(stationId),
      fetchArsoPercentileRow(stationId, month, day),
    ]);
    if (todayTemp == null || !perc) return { available: false };
    const cat = categorizeArso(todayTemp, perc);
    return {
      available: true, date,
      today_temp: todayTemp, is_preliminary: false,
      percentile: cat.percentile, category_key: cat.category_key, color: cat.color,
      n_samples: 0, year_min: 0, year_max: 0,
      distribution: syntheticDistribution(perc.p05, perc.p50, perc.p95),
      cutoffs: { p5: perc.p05, p10: perc.p05, p20: perc.p20, p50: perc.p50, p80: perc.p80, p95: perc.p95 },
      day_label: dayLabel(month, day), month_num: month, day_num: day,
      rank_info: null, loc: era5Name,
    };
  }

  // ERA5 path
  const stationId = vremenarIdMap[era5Name];
  let todayTemp: number | null = null;
  let isPreliminary = false;

  if (stationId) {
    todayTemp = await vremenarTemp(stationId);
  }
  if (todayTemp === null) {
    const rows = await dsGet<Array<{ temperature_max_2m: number }>>(
      `daily.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&date__exact=${date}&_col=temperature_max_2m&_size=1`
    );
    if (!rows[0]?.temperature_max_2m) return { available: false };
    todayTemp = rows[0].temperature_max_2m;
    isPreliminary = true;
  }

  const w = await fetchEra5WindowRow(era5Name, month, day);
  if (!w) return { available: false };

  const cat = categorizeEra5(todayTemp, w);
  return {
    available: true, date,
    today_temp: todayTemp, is_preliminary: isPreliminary,
    percentile: cat.percentile, category_key: cat.category_key, color: cat.color,
    n_samples: w.n_samples, year_min: w.year_min, year_max: w.year_max,
    distribution: JSON.parse(w.distribution_json) as [number, number][],
    cutoffs: { p5: w.p5, p10: w.p10, p20: w.p20, p50: w.p50, p80: w.p80, p95: w.p95 },
    day_label: dayLabel(month, day), month_num: month, day_num: day,
    rank_info: null, loc: era5Name,
  };
}

// ── fetchLast7 ─────────────────────────────────────────────────────────────────

export async function fetchLast7(date: string, loc: string | null): Promise<Last7> {
  const era5Name = loc ?? "Ljubljana";

  if (isArsoLoc(era5Name)) {
    const stationId = arsoStationId(era5Name);
    const rows = await sdGet(
      "temperature.slovenia_historical.daily",
      `station_id__exact=${stationId}&date__lte=${date}&_sort_desc=date&_size=7&_col=date&_col=temperature_max_2m&_col=month&_col=day`
    ) as Array<{ date: string; temperature_max_2m: number; month: number; day: number }>;

    if (!Array.isArray(rows) || !rows.length) return { available: false, days: [] };

    const dayResults = await Promise.all(
      rows.map(async r => {
        const perc = await fetchArsoPercentileRow(stationId, r.month, r.day);
        if (!perc || r.temperature_max_2m == null) return null;
        const cat = categorizeArso(r.temperature_max_2m, perc);
        return { date: r.date, day_label: dayLabel(r.month, r.day), today_temp: r.temperature_max_2m, percentile: cat.percentile, category_key: cat.category_key, color: cat.color };
      })
    );
    const days = dayResults.filter(Boolean) as Last7["days"];
    return { available: days.length > 0, days };
  }

  // ERA5 path
  const rows = await dsGet<Array<{
    date: string; temperature_max_2m: number; month: number; day: number;
  }>>(
    `daily.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&date__lte=${date}&_sort_desc=date&_size=7&_col=date&_col=temperature_max_2m&_col=month&_col=day`
  );
  if (!rows.length) return { available: false, days: [] };

  const dayResults = await Promise.all(
    rows.map(async r => {
      const w = await fetchEra5WindowRow(era5Name, r.month, r.day);
      if (!w || r.temperature_max_2m == null) return null;
      const cat = categorizeEra5(r.temperature_max_2m, w);
      return { date: r.date, day_label: dayLabel(r.month, r.day), today_temp: r.temperature_max_2m, percentile: cat.percentile, category_key: cat.category_key, color: cat.color };
    })
  );
  const days = dayResults.filter(Boolean) as Last7["days"];
  return { available: days.length > 0, days };
}

// ── fetchDailyWindow ───────────────────────────────────────────────────────────

export async function fetchDailyWindow(station: string | null, month: number, day: number): Promise<DailyWindowRow[]> {
  const loc = station ?? "Ljubljana";

  if (isArsoLoc(loc)) {
    const stationId = arsoStationId(loc);
    const perc = await fetchArsoPercentileRow(stationId, month, day);
    if (!perc) return [];
    return [{
      station: loc, month, day,
      p5: perc.p05, p10: perc.p05, p20: perc.p20, p50: perc.p50, p80: perc.p80, p95: perc.p95,
      n_samples: 0, year_min: 1950, year_max: 2024,
      distribution_json: "[]",
    }];
  }

  const rows = await dsGet<DailyWindowRow[]>(
    `daily_window.json?_shape=array&era5_name__exact=${encodeURIComponent(loc)}&month__exact=${month}&day__exact=${day}`
  );
  return rows.map(r => ({ ...r, station: (r as any).era5_name ?? loc }));
}

// ── fetchPageData ──────────────────────────────────────────────────────────────

export async function fetchPageData(
  date: string,
  loc: string | null,
): Promise<{ status: TodayStatus; last7: Last7 }> {
  const [status, last7] = await Promise.all([
    fetchTodayStatus(date, loc),
    fetchLast7(date, loc),
  ]);
  return { status, last7 };
}

// ── fetchSeasonHeatmap ─────────────────────────────────────────────────────────

export async function fetchSeasonHeatmap(loc?: string | null): Promise<SeasonHeatmapRow[]> {
  const era5Name = loc ?? "Ljubljana";
  if (isArsoLoc(era5Name)) return [];
  return dsGet<SeasonHeatmapRow[]>(
    `season_heatmap.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&_col=x&_col=y&_col=season&_col=avg&_col=percentile&_col=cat&_col=rank&_col=total&_col=color&_col=n_days&_size=500`
  );
}

// ── fetchRegression ────────────────────────────────────────────────────────────

export interface RegressionParams {
  locs:   string[];
  var:    string;
  doy:    number;
  window: number;
  corr:   "raw" | "corr";
  method: "theilsen" | "ols";
}

export async function fetchRegression(p: RegressionParams): Promise<RegressionResponse> {
  const { month, day } = doyToMonthDay(p.doy);
  const era5Locs = p.locs.filter(l => !isArsoLoc(l));

  const results = await Promise.all(
    era5Locs.map(loc => buildRegressionResult(loc, p.var, month, day))
  );

  return {
    results:    results.filter(Boolean) as RegressionResult[],
    date_label: dayLabel(month, day),
    ylabel:     VAR_LABELS[p.var] ?? `${p.var} (°C)`,
    unit:       "°C",
  };
}

async function buildRegressionResult(
  era5Name: string, variable: string, month: number, day: number
): Promise<RegressionResult | null> {
  const rows = await dsGet<AnnualTrendRow[]>(
    `annual_trend.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&variable__exact=${encodeURIComponent(variable)}&month__exact=${month}&day__exact=${day}&_size=1`
  );
  const r = rows[0];
  if (!r) return null;

  const scatter = JSON.parse(r.scatter_json) as Array<{ x: number; y: number }>;
  const baselineYears = scatter.filter(pt => pt.x >= 1961 && pt.x <= 1990);
  const baseline = baselineYears.length > 5
    ? baselineYears.reduce((s, pt) => s + pt.y, 0) / baselineYears.length
    : scatter.reduce((s, pt) => s + pt.y, 0) / scatter.length;

  return {
    loc: era5Name,
    year_min: r.year_min, year_max: r.year_max,
    scatter: scatter.map(pt => {
      const anomaly = pt.y - baseline;
      return { x: pt.x, y: pt.y, anomaly, color: anomaly >= 0 ? "#c25a2c" : "#3a5a8a" };
    }),
    line: {
      x:     JSON.parse(r.hist_x_json) as number[],
      y:     JSON.parse(r.hist_y_json) as number[],
      upper: JSON.parse(r.hist_upper_json) as number[],
      lower: JSON.parse(r.hist_lower_json) as number[],
    },
    baseline,
    stats: {
      method: "Theil-Sen + TFPW MK", trend10: r.trend10, metric: r.trend10,
      metric_lbl: "trend / 10y", p_val: r.p_val,
      direction: r.trend10 >= 0 ? "up" : "down",
      chg_str: `${r.trend10 >= 0 ? "+" : ""}${r.trend10.toFixed(2)} °C/10y`,
      fit_desc: `τ = ${r.tau.toFixed(2)}`,
      sig_label: r.p_val < 0.05 ? "p < 0.05" : `p = ${r.p_val.toFixed(3)}`,
      n_years: r.n_years, ar1: null,
    },
  };
}

// ── fetchArsoTrend ─────────────────────────────────────────────────────────────

export interface ArsoTrend {
  dayLabel:  string;
  yearMin:   number;
  yearMax:   number;
  nYears:    number;
  scatter:   Array<{ x: number; y: number }>;
  trendLine: Array<[number, number]>;
  trend10:   number;
}

export async function fetchArsoTrend(stationId: number, month: number, day: number): Promise<ArsoTrend | null> {
  // Fetch adjacent months to cover the ±7-day window near month boundaries
  const months = [...new Set([Math.max(1, month - 1), month, Math.min(12, month + 1)])];
  const chunks = await Promise.all(months.map(m =>
    sdGet(
      "temperature.slovenia_historical.daily",
      `station_id__exact=${stationId}&month__exact=${m}&_col=year&_col=month&_col=day&_col=temperature_max_2m&_size=1000`
    ) as Promise<Array<{ year: number; month: number; day: number; temperature_max_2m: number }>>
  ));
  const allRows = chunks.flat().filter(r => r.temperature_max_2m != null);
  if (!allRows.length) return null;

  const targetDoy = monthDayToDoy(month, day);
  const inWindow = allRows.filter(r => {
    const doy  = monthDayToDoy(r.month, r.day);
    const diff = Math.abs(doy - targetDoy);
    return Math.min(diff, 365 - diff) <= 7;
  });
  if (!inWindow.length) return null;

  // Group by year, take mean of daily max temperatures in the window
  const byYear = new Map<number, number[]>();
  for (const r of inWindow) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year)!.push(r.temperature_max_2m);
  }
  const scatter = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, temps]) => ({
      x: year,
      y: parseFloat((temps.reduce((s, t) => s + t, 0) / temps.length).toFixed(2)),
    }));

  if (scatter.length < 3) return null;

  // OLS linear regression
  const n     = scatter.length;
  const sumX  = scatter.reduce((s, p) => s + p.x, 0);
  const sumY  = scatter.reduce((s, p) => s + p.y, 0);
  const sumXY = scatter.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = scatter.reduce((s, p) => s + p.x * p.x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const yearMin = scatter[0].x;
  const yearMax = scatter[scatter.length - 1].x;
  return {
    dayLabel:  dayLabel(month, day),
    yearMin, yearMax,
    nYears:    scatter.length,
    scatter,
    trendLine: [
      [yearMin, parseFloat((slope * yearMin + intercept).toFixed(2))],
      [yearMax, parseFloat((slope * yearMax + intercept).toFixed(2))],
    ],
    trend10: parseFloat((slope * 10).toFixed(3)),
  };
}

// ── SPEI stubs (no precipitation data) ────────────────────────────────────────

export function fetchSpeiHeatmap(): Promise<{ available: boolean }> {
  return Promise.resolve({ available: false });
}

export function fetchSpeiStationSeasonal(): Promise<null> {
  return Promise.resolve(null);
}

// ── fetchCalendar ──────────────────────────────────────────────────────────────

export interface CalendarRow {
  month:   number;
  day:     number;
  trend10: number;
  p_val:   number;
}

export interface CalendarData {
  loc:          string;
  var:          string;
  unit:         string;
  method_label: string;
  rows:         CalendarRow[];
}

export async function fetchCalendar(
  loc: string, variable: string, _window: number,
  _corr: "raw" | "corr", _method: "theilsen" | "ols"
): Promise<CalendarData> {
  if (isArsoLoc(loc)) return { loc, var: variable, unit: "°C", method_label: "Theil-Sen + TFPW MK", rows: [] };
  const rows = await dsGet<CalendarRow[]>(
    `annual_trend.json?_shape=array&era5_name__exact=${encodeURIComponent(loc)}&variable__exact=${encodeURIComponent(variable)}&_col=month&_col=day&_col=trend10&_col=p_val&_size=400`
  );
  return { loc, var: variable, unit: "°C", method_label: "Theil-Sen + TFPW MK", rows };
}

// ── fetchAnnualTrend ───────────────────────────────────────────────────────────

export async function fetchAnnualTrend(month: number, day: number, loc?: string | null): Promise<AnnualTrend> {
  const era5Name = loc ?? "Ljubljana";
  if (isArsoLoc(era5Name)) throw new Error("Annual trend not available for ARSO stations");
  const rows = await dsGet<AnnualTrendRow[]>(
    `annual_trend.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&variable__exact=temperature_mean&month__exact=${month}&day__exact=${day}&_size=1`
  );
  if (!rows.length) throw new Error("No annual trend row");
  const r = rows[0]!;
  return {
    dayLabel: r.day_label, monthNum: r.month, dayNum: r.day,
    yearMin: r.year_min, yearMax: r.year_max,
    trend10: r.trend10, pVal: r.p_val, tau: r.tau, nYears: r.n_years,
    scatter: JSON.parse(r.scatter_json) as Array<{ x: number; y: number }>,
    histLine: { x: JSON.parse(r.hist_x_json), y: JSON.parse(r.hist_y_json), upper: JSON.parse(r.hist_upper_json), lower: JSON.parse(r.hist_lower_json) },
    projLine: { x: JSON.parse(r.proj_x_json), y: JSON.parse(r.proj_y_json), upper: JSON.parse(r.proj_upper_json), lower: JSON.parse(r.proj_lower_json) },
  };
}
