import { cn } from "@viz/lib/classMerge";

export const ErrorCard = ({
  message,
  className,
}: {
  message: string;
  className?: string;
}) => {
  return (
    <div
      className={cn(
        "flex min-h-28 items-center justify-center rounded-control border border-status-danger-boundary bg-status-danger-surface",
        className,
      )}
    >
      <span className="text-status-danger p-3 text-center">{message}</span>
    </div>
  );
};
