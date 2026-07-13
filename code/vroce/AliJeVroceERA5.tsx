import { createSignal, createResource, Show, Suspense, lazy, For } from "solid-js";
import { fetchMeta, ARSO_NATIONAL } from "./api.ts";
import type { SiteMeta } from "./types.ts";

// Only below-the-fold sections stay lazy
const ArsoSeasonHeatmapChart  = lazy(() => import("./charts/ArsoSeasonHeatmap.tsx").then(m => ({ default: m.ArsoSeasonHeatmap })));
const ArsoTropicalDaysChart   = lazy(() => import("./charts/ArsoTropicalChart.tsx").then(m => ({ default: m.ArsoTropicalChart })));
const ArsoTropicalNightsChart = lazy(() => import("./charts/ArsoTropicalChart.tsx").then(m => ({ default: m.ArsoTropicalChart })));

export function AliJeVroceERA5() {
  const [meta] = createResource<SiteMeta>(fetchMeta);
  return (
    <Show when={meta()} fallback={<div class="px-10 py-8 text-[var(--color-ink-soft)]">Nalaganje…</div>}>
      {(m) => <Dashboard meta={m()} />}
    </Show>
  );
}

function Dashboard(props: { meta: SiteMeta }) {
  const arsoStations = props.meta.stations.filter(s => s.source === "arso");
  const [loc, setLoc] = createSignal<string | null>(ARSO_NATIONAL);

  return (
    <div>

      {/* ── Page heading + station picker ───────────────────────────── */}
      <section class="today-status">
        <div class="sec-heading">
          <div class="today-heading-text">
            <span class="today-heading-title">ARSO — Podnebnik</span>
            <span class="today-heading-subtitle">sezonski pregled temperatur po ARSO postajah</span>
          </div>
        </div>
        <div style={{ display: "flex", "justify-content": "center", padding: "16px 0 24px" }}>
          <select
            class="today-loc-select"
            value={loc() === ARSO_NATIONAL ? (ARSO_NATIONAL ?? "") : loc() ?? ""}
            onChange={(e) => setLoc(e.currentTarget.value === ARSO_NATIONAL ? ARSO_NATIONAL : e.currentTarget.value || null)}
          >
            <option value={ARSO_NATIONAL ?? ""}>Slovenija</option>
            <optgroup label="ARSO postaje">
              <For each={arsoStations}>
                {(s) => <option value={s.name}>{s.label}</option>}
              </For>
            </optgroup>
          </select>
        </div>
      </section>

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
            <ArsoSeasonHeatmapChart loc={loc()} label={arsoStations.find(s => s.name === loc())?.label} />
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
              label={arsoStations.find(s => s.name === loc())?.label}
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
              label={arsoStations.find(s => s.name === loc())?.label}
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
