import type {
  TodayStatus, Last7, AnnualTrendRow, AnnualTrend, SiteMeta,
  SeasonHeatmapRow, RegressionResult, RegressionResponse, DailyWindowRow,
} from "./types.ts";

// Datasette base — same-origin by default; override with VITE_DATASETTE_URL for cross-origin dev
const DS = `${import.meta.env.VITE_DATASETTE_URL ?? ""}/datasette/climate-si`;
// Vremenar live proxy — same-origin by default; override with VITE_VREMENAR_URL for cross-origin dev
const VR = `${import.meta.env.VITE_VREMENAR_URL ?? ""}/vremenar/staging`;

// Populated during fetchMeta() from the Datasette stations table (station_id column)
let vremenarIdMap: Record<string, number> = {};

// category_key thresholds aligned with TodayGauge BOUNDS [0,10,20,80,95,101]
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

function doyToMonthDay(doy: number): { month: number; day: number } {
  const d = new Date(Date.UTC(2001, 0, 1));
  d.setUTCDate(d.getUTCDate() + doy - 1);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function dateToMonthDay(dateStr: string): { month: number; day: number } {
  const [, m, d] = dateStr.split("-");
  return { month: Number(m), day: Number(d) };
}

function dayLabel(month: number, day: number): string {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${MONTHS[month - 1]} ${day}`;
}

function categorize(temp: number, w: DailyWindowRow): { category_key: string; percentile: number; color: string } {
  if (temp >= w.p95) return { category_key: "hell",     percentile: 97.5, color: CAT_COLORS.hell     };
  if (temp >= w.p80) return { category_key: "hot",      percentile: 87.5, color: CAT_COLORS.hot      };
  if (temp >= w.p20) return { category_key: "nope",     percentile: 50,   color: CAT_COLORS.nope     };
  if (temp >= w.p10) return { category_key: "cold",     percentile: 15,   color: CAT_COLORS.cold     };
  return                    { category_key: "freezing", percentile:  5,   color: CAT_COLORS.freezing };
}

async function fetchDailyWindowRow(era5Name: string, month: number, day: number): Promise<DailyWindowRow | null> {
  const rows = await dsGet<DailyWindowRow[]>(
    `daily_window.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&month__exact=${month}&day__exact=${day}`
  );
  return rows[0] ?? null;
}

// ── fetchMeta ──────────────────────────────────────────────────────────────────

export async function fetchMeta(): Promise<SiteMeta> {
  const stations = await dsGet<Array<{
    era5_name: string; name: string; lat: number; lon: number;
    elevation: number; station_id: number | null;
  }>>(
    "stations.json?_shape=array&_col=era5_name&_col=name&_col=lat&_col=lon&_col=elevation&_col=station_id&_size=30"
  );

  // Build the Vremenar live-data map from what's actually in the database
  vremenarIdMap = Object.fromEntries(
    stations
      .filter(s => s.station_id != null)
      .map(s => [s.era5_name, s.station_id as number])
  );

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
    stations: stations.map(s => ({
      name:      s.era5_name,
      label:     s.name,
      lat:       s.lat,
      lon:       s.lon,
      elevation: s.elevation,
    })),
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
  const stationId = vremenarIdMap[era5Name];

  let todayTemp: number | null = null;
  let isPreliminary = false;

  if (stationId) {
    try {
      const vr = await fetch(`${VR}/stations/details/METEO-${stationId}?country=si`);
      if (vr.ok) {
        const vrData = await vr.json() as { statistics?: { temperature_max_24h?: number } };
        todayTemp = vrData?.statistics?.temperature_max_24h ?? null;
      }
    } catch {
      // fall through to ERA5 fallback
    }
  }

  if (todayTemp === null) {
    const rows = await dsGet<Array<{ temperature_max_2m: number }>>(
      `daily.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&date__exact=${date}&_col=temperature_max_2m&_size=1`
    );
    if (!rows[0]?.temperature_max_2m) return { available: false };
    todayTemp = rows[0].temperature_max_2m;
    isPreliminary = true;
  }

  const w = await fetchDailyWindowRow(era5Name, month, day);
  if (!w) return { available: false };

  const cat = categorize(todayTemp, w);
  return {
    available:    true,
    date,
    today_temp:   todayTemp,
    percentile:   cat.percentile,
    category_key: cat.category_key,
    color:        cat.color,
    n_samples:    w.n_samples,
    year_min:     w.year_min,
    year_max:     w.year_max,
    distribution: JSON.parse(w.distribution_json) as [number, number][],
    cutoffs: {
      p5:  w.p5,
      p10: w.p10,
      p20: w.p20,
      p50: w.p50,
      p80: w.p80,
      p95: w.p95,
    },
    day_label:      dayLabel(month, day),
    month_num:      month,
    day_num:        day,
    rank_info:      null,
    loc:            era5Name,
    is_preliminary: isPreliminary,
  };
}

// ── fetchLast7 ─────────────────────────────────────────────────────────────────

export async function fetchLast7(date: string, loc: string | null): Promise<Last7> {
  const era5Name = loc ?? "Ljubljana";

  const rows = await dsGet<Array<{
    date: string; temperature_max_2m: number; month: number; day: number;
  }>>(
    `daily.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&date__lte=${date}&_sort_desc=date&_size=7&_col=date&_col=temperature_max_2m&_col=month&_col=day`
  );

  if (!rows.length) return { available: false, days: [] };

  const dayResults = await Promise.all(
    rows.map(async (r) => {
      const w = await fetchDailyWindowRow(era5Name, r.month, r.day);
      if (!w || r.temperature_max_2m == null) return null;
      const cat = categorize(r.temperature_max_2m, w);
      return {
        date:         r.date,
        day_label:    dayLabel(r.month, r.day),
        today_temp:   r.temperature_max_2m,
        percentile:   cat.percentile,
        category_key: cat.category_key,
        color:        cat.color,
      };
    })
  );

  const days = dayResults.filter(Boolean) as Last7["days"];
  return { available: days.length > 0, days };
}

// ── fetchDailyWindow ───────────────────────────────────────────────────────────

export async function fetchDailyWindow(station: string | null, month: number, day: number): Promise<DailyWindowRow[]> {
  const era5Name = station ?? "Ljubljana";
  const rows = await dsGet<DailyWindowRow[]>(
    `daily_window.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&month__exact=${month}&day__exact=${day}`
  );
  return rows.map(r => ({ ...r, station: (r as any).era5_name ?? era5Name }));
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

  const results = await Promise.all(
    p.locs.map(loc => buildRegressionResult(loc, p.var, month, day))
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
    loc:      era5Name,
    year_min: r.year_min,
    year_max: r.year_max,
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
      method:     "Theil-Sen + TFPW MK",
      trend10:    r.trend10,
      metric:     r.trend10,
      metric_lbl: "trend / 10y",
      p_val:      r.p_val,
      direction:  r.trend10 >= 0 ? "up" : "down",
      chg_str:    `${r.trend10 >= 0 ? "+" : ""}${r.trend10.toFixed(2)} °C/10y`,
      fit_desc:   `τ = ${r.tau.toFixed(2)}`,
      sig_label:  r.p_val < 0.05 ? "p < 0.05" : `p = ${r.p_val.toFixed(3)}`,
      n_years:    r.n_years,
      ar1:        null,
    },
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
  const rows = await dsGet<CalendarRow[]>(
    `annual_trend.json?_shape=array&era5_name__exact=${encodeURIComponent(loc)}&variable__exact=${encodeURIComponent(variable)}&_col=month&_col=day&_col=trend10&_col=p_val&_size=400`
  );
  return { loc, var: variable, unit: "°C", method_label: "Theil-Sen + TFPW MK", rows };
}

// ── fetchAnnualTrend ───────────────────────────────────────────────────────────

export async function fetchAnnualTrend(month: number, day: number, loc?: string | null): Promise<AnnualTrend> {
  const era5Name = loc ?? "Ljubljana";
  const rows = await dsGet<AnnualTrendRow[]>(
    `annual_trend.json?_shape=array&era5_name__exact=${encodeURIComponent(era5Name)}&variable__exact=temperature_mean&month__exact=${month}&day__exact=${day}&_size=1`
  );
  if (!rows.length) throw new Error("No annual trend row");
  const r = rows[0]!;
  return {
    dayLabel:  r.day_label,
    monthNum:  r.month,
    dayNum:    r.day,
    yearMin:   r.year_min,
    yearMax:   r.year_max,
    trend10:   r.trend10,
    pVal:      r.p_val,
    tau:       r.tau,
    nYears:    r.n_years,
    scatter:   JSON.parse(r.scatter_json) as Array<{ x: number; y: number }>,
    histLine: {
      x:     JSON.parse(r.hist_x_json) as number[],
      y:     JSON.parse(r.hist_y_json) as number[],
      upper: JSON.parse(r.hist_upper_json) as number[],
      lower: JSON.parse(r.hist_lower_json) as number[],
    },
    projLine: {
      x:     JSON.parse(r.proj_x_json) as number[],
      y:     JSON.parse(r.proj_y_json) as number[],
      upper: JSON.parse(r.proj_upper_json) as number[],
      lower: JSON.parse(r.proj_lower_json) as number[],
    },
  };
}
