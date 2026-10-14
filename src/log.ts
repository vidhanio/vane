export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
