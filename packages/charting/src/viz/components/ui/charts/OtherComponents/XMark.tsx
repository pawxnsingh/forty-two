function xmark(props: { strokewidth?: number }) {
  const strokewidth = props.strokewidth || 1.3;

  return (
    <svg
      height="1em"
      width="1em"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Close"
    >
      <title>Close</title>
      <g fill="currentColor">
        <path
          d="M14 4L4 14"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={strokewidth}
        />
        <path
          d="M4 4L14 14"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={strokewidth}
        />
      </g>
    </svg>
  );
}

export default xmark;
