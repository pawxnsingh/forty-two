import { ClientOnly } from '@viz/_shims/react-router';
import { lazy, Suspense } from 'react';
import { LazyErrorBoundary } from '@viz/components/features/global/LazyErrorBoundary';
import { PreparingYourRequestLoader } from './LoadingComponents/ChartLoadingComponents';

const ChartLazy = lazy(() =>
  import('./Chart').then((mod) => ({ default: mod.Chart }))
);

export const ChartDynamic = (props: Parameters<typeof ChartLazy>[0]) => (
  <LazyErrorBoundary>
    <Suspense fallback={<PreparingYourRequestLoader text="Loading chart..." />}>
      <ChartLazy {...props} />
    </Suspense>
  </LazyErrorBoundary>
);

ChartDynamic.preload = async () => await import('./Chart');
