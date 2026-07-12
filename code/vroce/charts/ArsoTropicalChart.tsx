import { createResource, createMemo, Show, onMount, onCleanup, createEffect } from "solid-js";
import { fetchArsoTropical, isArsoLoc } from "../api.ts";
import type { ArsoTropicalData } from "../api.ts";

const INK      = "#0E0E0C";
const INK_SOFT = "#6B655B";
const BAR_HOT  = "rgba(194,90,44,0.65)";
const BAR_NIL  = "rgba(150,44,26,0.35)";
const TREND    = "#962c1a";
const MONO     = { fontFamily: "'JetBrains Mono', monospace", fontSize: "9px" };

function ArsoTropicalHighchart(props: { data: ArsoTropicalData; threshold: number }) {
  let container!: HTMLDivElement;
  let chart: any = null;

  function barColors(years: number[], counts: number[], thr: number) {
    return years.map((_, i) => counts[i]! > 0 ? BAR_HOT : BAR_NIL);
  }

  onMount(async () => {
    const Highcharts = (await import("highcharts")).default;
    const d = props.data;
    const colors = barColors(d.years, d.counts, props.threshold);

    chart = Highcharts.chart(container, {
      chart: {
        type:            "column",
        height:          220,
        margin:          [16, 16, 40, 44],
        backgroundColor: "transparent",
        animation:       false,
      },
      title:   { text: null },
      credits: { enabled: false },
      legend:  { enabled: false },
      tooltip: {
        formatter(this: any) {
          if (this.series.type === "column") return `<b>${this.x}</b>: ${this.y} dni`;
          return false;
        },
      },
      xAxis: {
        categories:    d.years.map(String),
        labels:        { step: 10, style: { color: INK_SOFT, ...MONO } },
        lineColor:     "rgba(14,14,12,0.1)",
        tickColor:     "rgba(14,14,12,0.1)",
        gridLineWidth: 0,
      },
      yAxis: {
        title:         { text: null },
        labels:        { style: { color: INK_SOFT, ...MONO } },
        gridLineColor: "rgba(14,14,12,0.06)",
        min:           0,
        allowDecimals: false,
      },
      series: [
        {
          type:    "column" as any,
          name:    "Število dni",
          data:    d.counts.map((c, i) => ({ y: c, color: colors[i] })),
          groupPadding:  0,
          pointPadding:  0.1,
          borderWidth:   0,
          zIndex:        3,
        },
        {
          type:                "line" as any,
          name:                "Trend",
          data:                d.trendLine.map(([x, y]) => [d.years.indexOf(x), y]),
          color:               TREND,
          lineWidth:           1.5,
          enableMouseTracking: false,
          marker:              { enabled: false },
          zIndex:              6,
        },
      ],
    } as Highcharts.Options);
  });

  createEffect(() => {
    const d = props.data;
    if (!chart) return;
    const colors = barColors(d.years, d.counts, props.threshold);
    chart.series[0]?.setData(
      d.counts.map((c, i) => ({ y: c, color: colors[i] })),
      false, false, false,
    );
    chart.series[1]?.setData(
      d.trendLine.map(([x, y]) => [d.years.indexOf(x), y]),
      false, false, false,
    );
    chart.xAxis[0]?.setCategories(d.years.map(String), false);
    chart.redraw(false);
  });

  onCleanup(() => { chart?.destroy(); chart = null; });

  return <div ref={container} />;
}

interface Props {
  loc:       string | null;
  label?:    string;
  kind:      "days" | "nights";
  threshold: number;
}

export function ArsoTropicalChart(props: Props) {
  const stationId = createMemo(() => {
    const l = props.loc ?? "";
    return isArsoLoc(l) ? Number(l.replace("arso:", "")) : null;
  });

  const [data] = createResource(
    () => {
      const id = stationId();
      return id != null ? { id, kind: props.kind, threshold: props.threshold } : null;
    },
    ({ id, kind, threshold }) => fetchArsoTropical(id, kind, threshold),
  );

  const display = () => data() ?? data.latest;

  const kindLabel = () => props.kind === "days" ? "tropski dnevi" : "tropske noči";
  const fieldLabel = () => props.kind === "days" ? "najvišja" : "najnižja";

  return (
    <div class="today-chart">
      <Show when={display()}>
        {(d) => {
          const sign = () => d().trend10 >= 0 ? "+" : "";
          return (
            <>
              <div class="today-chart-title">
                {kindLabel().charAt(0).toUpperCase() + kindLabel().slice(1)}
                {props.label ? ` na postaji ${props.label}` : ""}
                {` · ${d().yearMin}–${d().yearMax} · prag ${props.threshold} °C`}
              </div>
              <ArsoTropicalHighchart data={d()} threshold={props.threshold} />
              <p class="today-explain" style={{ padding: "4px 0 2px" }}>
                Število let, ko je {fieldLabel()} dnevna temperatura presegla {props.threshold} °C. Trend linearne regresije: {sign()}{d().trend10.toFixed(2)} dni/desetletje.
              </p>
              <div class="today-foot">
                Linearna regresija OLS · {sign()}{d().trend10.toFixed(2)} dni/desetletje · vir: ARSO · {d().yearMin}–{d().yearMax}
              </div>
            </>
          );
        }}
      </Show>
      <Show when={data.loading && !display()}>
        <div style={{ height: "220px" }} class="animate-pulse bg-[var(--color-paper-2)] rounded" />
      </Show>
    </div>
  );
}
