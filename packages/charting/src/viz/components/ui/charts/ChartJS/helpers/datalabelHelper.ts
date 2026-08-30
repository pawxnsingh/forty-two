import type { Context } from 'chartjs-plugin-datalabels';
import { determineFontColorContrast } from '@viz/lib/colors';

export const dataLabelFontColorContrast = (context: Context) => {
  const color = context.dataset.backgroundColor as string;
  return determineFontColorContrast(color);
};
