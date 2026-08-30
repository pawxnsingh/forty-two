import type React from "react";
import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

interface Props {
  children: ReactNode;
}

const ErrorCardComponent: React.FC = () => {
  return (
    <div className="rounded-surface-soft border border-status-danger-boundary bg-status-danger-surface p-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-label font-medium text-status-danger">
          Chart rendering error
        </h3>
        <p className="text-label text-status-danger">
          Something went wrong rendering the chart. This is likely an error on
          our end. Please contact support.
        </p>
      </div>
    </div>
  );
};

export const ChartErrorWrapper: React.FC<Props> = ({ children }) => {
  return (
    <ErrorBoundary fallback={<ErrorCardComponent />}>{children}</ErrorBoundary>
  );
};
