import { createSignal, createResource, createMemo, Show, Suspense, lazy } from "solid-js";

const EN_MONTHS: Record<string, string> = {
  Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
  Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12",
};
function fmtDayLabel(dl: string): string {
  const [mon, day] = dl.split(" ");
  return `${(day ?? "").padStart(2, "0")}.${EN_MONTHS[mon ?? ""] ?? "??"}`;
}
import { fetchMeta, fetchPageData, isArsoLoc, ARSO_NATIONAL } from "./api.ts";
import { TodayCard } from "./components/TodayCard.tsx";
import { DistributionChart } from "./charts/DistributionChart.tsx";
import { TodayTrendChart }   from "./components/TodayTrendChart.tsx";
import { ArsoTrendChart }    from "./components/ArsoTrendChart.tsx";
import { RegressionPanel, RegToolbar, RegScatterCard, RegYearRoundCard,
         panelHStyle, panelTitleStyle, panelSubStyle } from "./components/RegressionPanel.tsx";
import type { SiteMeta } from "./types.ts";

// Only below-the-fold sections stay lazy
const ArsoSeasonHeatmapChart  = lazy(() => import("./charts/ArsoSeasonHeatmap.tsx").then(m => ({ default: m.ArsoSeasonHeatmap })));
const ArsoTropicalDaysChart   = lazy(() => import("./charts/ArsoTropicalChart.tsx").then(m => ({ default: m.ArsoTropicalChart })));
const ArsoTropicalNightsChart = lazy(() => import("./charts/ArsoTropicalChart.tsx").then(m => ({ default: m.ArsoTropicalChart })));
const StationMap               = lazy(() => import("./components/StationMap.tsx").then(m => ({ default: m.StationMap })));

function dateToDoy(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00Z");
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

export function AliJeVroceERA5() {
  const [meta] = createResource<SiteMeta>(fetchMeta);
  return (
    <Show when={meta()} fallback={<div class="px-10 py-8 text-[var(--color-ink-soft)]">Nalaganje…</div>}>
      {(m) => <Dashboard meta={m()} />}
    </Show>
  );
}

function Dashboard(props: { meta: SiteMeta }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = createSignal(today);

  // Default to national ARSO average
  const arsoStations = props.meta.stations.filter(s => s.source === "arso");
  const [loc,  setLoc]  = createSignal<string | null>(ARSO_NATIONAL);

  const defaultDoy = createMemo(() => dateToDoy(date()));
  const isArso = createMemo(() => isArsoLoc(loc() ?? ""));

  // Pass only ARSO stations to the picker
  const arsoMeta = (): SiteMeta => ({ ...props.meta, stations: arsoStations });

  const [pageData] = createResource(
    () => ({ date: date(), loc: loc() }),
    ({ date, loc }) => fetchPageData(date, loc),
  );
  const pageDataResolved = () => pageData() ?? pageData.latest;
  const todayData = () => pageDataResolved()?.status;
  const last7Data = () => pageDataResolved()?.last7;

  const [mapLoc, setMapLoc] = createSignal<string | null>(null);

  return (
    <div>

      {/* ── Today status section ──────────────────────────────────── */}
      <section class="today-status">
        <div class="sec-heading">
          <div class="today-heading-text">
            <span class="today-heading-title">ARSO — Ali je vroče?</span>
            <span class="today-heading-subtitle">meritve ARSO postaj v primerjavi z zgodovinskimi percentili</span>
          </div>
        </div>

        <div class="today-grid">
          <Show
            when={todayData()}
            fallback={<div style={{ "min-height": "480px", "grid-column": "1 / -1" }} class="animate-pulse rounded-xl bg-[var(--color-paper-2)]" />}
          >
            {(r) => (
              <TodayCard
                data={r()}
                last7={last7Data()}
                meta={arsoMeta()}
                date={date()}
                today={today}
                loading={pageData.loading}
                onDateChange={setDate}
                onLocChange={(v) => setLoc(v === "" ? ARSO_NATIONAL : v || null)}
                nationalLoc={ARSO_NATIONAL}
              />
            )}
          </Show>

          <Show when={todayData()?.available}>
            <div class="today-chart">
              <div class="today-chart-title">
                {isArso()
                  ? `Porazdelitev temperatur ARSO za ${fmtDayLabel(todayData()!.day_label ?? "")}`
                  : `Dnevne najvišje temperature ${todayData()?.loc ? `na postaji ${todayData()!.loc!.replace(/_/g, " ")}` : "v Sloveniji"} za dve tedni okoli ${fmtDayLabel(todayData()!.day_label ?? "")} od ${todayData()!.year_min}`
                }
              </div>
              <DistributionChart data={todayData()!} chartId="dist-chart" />
              <p class="today-explain" style={{ "font-size": "12px", "padding-top": "6px" }}>
                {isArso()
                  ? "Krivulja je aproksimacija normalne porazdelitve iz percentilnih vrednosti ARSO meritev (p5, p20, p50, p80, p95). Barvni pasovi prikazujejo klimatološke cone."
                  : "Krivulja prikazuje, kako pogosto se je pojavila vsaka vrhunska temperatura na dneve, kot je danes, v vseh letih. Barve označujejo klimatološke cone — od hladne modre prek tipičnega bežastega pasu do ekstremne rdeče."
                }
              </p>
              <div class="today-foot">
                {isArso()
                  ? `Danes: ${todayData()!.today_temp!.toFixed(1)} °C · ${todayData()!.percentile!.toFixed(0)}. percentil · mediana ${todayData()!.cutoffs!.p50.toFixed(1)} °C · vir: ARSO`
                  : `Danes: ${todayData()!.today_temp!.toFixed(1)} °C · ${todayData()!.percentile!.toFixed(0)}. percentil · mediana ${todayData()!.cutoffs!.p50.toFixed(1)} °C · ${(todayData()!.n_samples ?? 0).toLocaleString()} opazovanj · ${todayData()!.year_min}–${todayData()!.year_max}`
                }
              </div>
            </div>
          </Show>

          <Show when={todayData()?.available && !isArso()}>
            <TodayTrendChart date={date()} loc={loc()} />
          </Show>
          <Show when={todayData()?.available && isArso() && loc() !== ARSO_NATIONAL}>
            <ArsoTrendChart
              date={date()} loc={loc()}
              label={props.meta.stations.find(s => s.name === loc())?.label}
            />
          </Show>
        </div>
      </section>

      {/* ── Regression section (ERA5 only) ───────────────────────────
           Hide entirely when an ARSO station is selected in TodayCard,
           since regression/calendar use ERA5 annual_trend table only.
      ──────────────────────────────────────────────────────────────── */}
      <Show when={!isArso()}>
      {/* ── Regression section ────────────────────────────────────────
           Layout (mirrors original):
           1. sec-hs heading
           2. toolbar  — full width, margin 40px
           3. main-row — grid: min(460px,44%) | 1fr, padding 20px 40px
              left:  map panel
              right: scatter chart panel
           4. cal-section — full width, year-round chart, margin 40px
      ──────────────────────────────────────────────────────────────── */}
      <RegressionPanel
        meta={props.meta}
        defaultDoy={defaultDoy()}
        syncLoc={mapLoc}
        onLocChange={setMapLoc}
      >
        <div class="sec-hs">Analiza trendov</div>

        <RegToolbar />

        <div class="main-row">

          {/* Map panel */}
          <div class="reg-card" style={{ background: "var(--color-paper)" }}>
            <div style={{ ...panelHStyle, background: "var(--color-card)" }}>
              <div>
                <div style={panelTitleStyle}>
                  {mapLoc() ? mapLoc()!.replace(/_/g, " ") : "Slovenija — vse postaje"}
                </div>
                <div style={{ ...panelSubStyle, "margin-top": "3px" }}>
                  {props.meta.stations.length} postaj
                </div>
              </div>
            </div>
            <Suspense fallback={<div style={{ height: "280px" }} class="animate-pulse bg-[var(--color-paper-2)]" />}>
              <StationMap meta={props.meta} loc={mapLoc()} onSelect={setMapLoc} />
            </Suspense>
            {/* Elevation legend */}
            <div style={{ padding: "8px 12px 10px", borderTop: "1px solid var(--color-rule)", display: "flex", gap: "10px", flexWrap: "wrap", background: "var(--color-card)" }}>
              {([
                ["#7bafd4", "Alpska (>1500m)"],
                ["#a3c4a0", "Gorska (800–1500m)"],
                ["#c8b97a", "Predgorska (400–800m)"],
                ["#c25a2c", "Nižinska (<400m)"],
              ] as [string, string][]).map(([color, label]) => (
                <span style={{ display: "flex", alignItems: "center", gap: "5px", fontFamily: "var(--font-mono)", fontSize: "9px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-ink-soft)" }}>
                  <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: color, display: "inline-block", border: "1px solid rgba(0,0,0,0.15)", flexShrink: "0" }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Regression scatter panel */}
          <RegScatterCard />

        </div>

        {/* Year-round trend — full width below the grid */}
        <div class="cal-section">
          <RegYearRoundCard />
        </div>

      </RegressionPanel>
      </Show>

      {/* ── Per-station charts (hidden when national average selected) ── */}
      <Show when={loc() !== ARSO_NATIONAL}>

        {/* ── ARSO: Season heatmap ────────────────────────────────── */}
        <section class="sec-p" style={{ "padding-bottom": "40px" }}>
          <div class="sec-h" style={{ "padding-inline": "0", "padding-top": "24px" }}>
            Sezonski pregled
          </div>
          <div class="sec-hs2">
            Povprečna najvišja temperatura po sezonah · ARSO meritve · barve glede na referenčno obdobje
          </div>
          <Suspense fallback={<div class="h-40 animate-pulse bg-[var(--color-paper-2)] rounded-xl" />}>
            <ArsoSeasonHeatmapChart loc={loc()} label={arsoMeta().stations.find(s => s.name === loc())?.label} />
          </Suspense>
        </section>

        {/* ── ARSO: Tropical days ─────────────────────────────────── */}
        <section class="sec-p" style={{ "padding-bottom": "40px" }}>
          <div class="sec-h" style={{ "padding-inline": "0", "padding-top": "8px" }}>
            Tropski dnevi
          </div>
          <div class="sec-hs2">
            Število dni z najvišjo temperaturo nad 30 °C · ARSO meritve · linearna regresija OLS
          </div>
          <Suspense fallback={<div class="h-56 animate-pulse bg-[var(--color-paper-2)] rounded-xl" />}>
            <ArsoTropicalDaysChart
              loc={loc()} kind="days" threshold={30}
              label={arsoMeta().stations.find(s => s.name === loc())?.label}
            />
          </Suspense>
        </section>

        {/* ── ARSO: Tropical nights ───────────────────────────────── */}
        <section class="sec-p" style={{ "padding-bottom": "40px" }}>
          <div class="sec-h" style={{ "padding-inline": "0", "padding-top": "8px" }}>
            Tropske noči
          </div>
          <div class="sec-hs2">
            Število noči z najnižjo temperaturo nad 20 °C · ARSO meritve · linearna regresija OLS
          </div>
          <Suspense fallback={<div class="h-56 animate-pulse bg-[var(--color-paper-2)] rounded-xl" />}>
            <ArsoTropicalNightsChart
              loc={loc()} kind="nights" threshold={20}
              label={arsoMeta().stations.find(s => s.name === loc())?.label}
            />
          </Suspense>
        </section>

      </Show>

      <Show when={loc() === ARSO_NATIONAL}>
        <section class="sec-p" style={{ "padding-bottom": "60px" }}>
          <p style={{ "padding-top": "32px", color: "var(--color-ink-soft)", "font-size": "14px", "text-align": "center" }}>
            Izberi ARSO postajo za sezonski pregled in analizo tropskih dni.
          </p>
        </section>
      </Show>

    </div>
  );
}
