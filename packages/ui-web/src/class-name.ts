type ClassName<T> = string | ((values: T) => string);

export function composeClassName<T>(
  required: readonly string[],
  consumer?: ClassName<T>,
): (values: T) => string {
  return (values) => {
    const consumerClassName = typeof consumer === "function" ? consumer(values) : consumer;
    return [...required, consumerClassName].filter(Boolean).join(" ");
  };
}
