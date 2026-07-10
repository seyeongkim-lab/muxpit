export interface SparklineSeries {
  data: number[];
  color: string;
  /** Area fill under the line. Defaults to `${color}15` (assumes a hex color);
   * pass "none" for a line-only series (needed when color is a CSS var). */
  fill?: string;
}

interface SparklineProps {
  series: SparklineSeries[];
  height?: number;
  /** viewBox width. The svg stretches to its container (preserveAspectRatio
   * none), so match this to the rendered width to keep strokes undistorted. */
  width?: number;
  autoMax?: boolean;
  fixedMax?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

// SVG sparkline from time series data. Series are drawn in order, so put the
// primary series last to keep it on top.
export const Sparkline = ({ series, height = 28, width = 180, autoMax, fixedMax, strokeWidth = 1.5, style }: SparklineProps) => {
  const drawable = series.filter((s) => s.data.length >= 2);
  if (drawable.length === 0) return null;
  const max = fixedMax ? fixedMax : autoMax ? Math.max(...drawable.flatMap((s) => s.data), 1) : 100;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={style} aria-hidden="true">
      {drawable.map((s, i) => {
        const points = s.data.map((v, j) => {
          const x = (j / (s.data.length - 1)) * width;
          const y = height - (v / max) * height;
          return `${x},${y}`;
        });
        const fill = s.fill ?? `${s.color}15`;
        return (
          <g key={i}>
            {fill !== "none" && <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={fill} />}
            <polyline points={points.join(" ")} fill="none" stroke={s.color} strokeWidth={strokeWidth} />
          </g>
        );
      })}
    </svg>
  );
};
