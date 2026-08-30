// Public entry for the config-driven chart renderer.
//
// Importing the renderer also runs its Chart.js theme setup, which sets `resizeDelay = 5`. That
// non-zero value triggers a known annotation-plugin crash on slow first paints
// (clipArea runs on an undefined chartArea -> "reading 'left'"). Resetting it to 0 here means
// EVERY consumer of the generic `Chart` is protected — not just the standalone test page.

import { Chart as ChartJS } from 'chart.js';
import { Chart } from './components/ui/charts/Chart';

ChartJS.defaults.resizeDelay = 0;

// Chart.js paints to a raster <canvas> sized = CSS size x devicePixelRatio. By default it uses the
// display's DPR, so on a 1x screen the canvas is low-res and looks soft when the page is pinch/zoomed
// (zoom magnifies the fixed bitmap; it does not re-rasterize). Floor the backing resolution at 2x so
// non-retina screens still render crisp charts and have headroom before zoom softens them. (Canvas is
// resolution-bound — beyond the backing resolution it will still blur; only an SVG renderer is zoom-
// infinite. Downloads re-render the chart at a large size for full crispness.)
ChartJS.defaults.devicePixelRatio = Math.max(
  2,
  (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
);

export { Chart };
