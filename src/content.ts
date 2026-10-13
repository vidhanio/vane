export const content = (value: unknown) => [
  {
    type: "text" as const,
    text: typeof value === "string" ? value : JSON.stringify(value),
  },
];
