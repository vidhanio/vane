export type Part = [level: number, index: number];
export type Node = { l: number; i: number; text: string; size: number };
export const bytes = (text: string) => Buffer.byteLength(text, "utf8");
export const start = ([l, i]: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part[0];
export const key = ([l, i]: Part) => `${l}:${i}`;
export const label = (part: Part) => `${start(part)}+${2 ** part[0]}`;
export const parent = ([l, i]: Part): Part => [l + 1, Math.floor(i / 2)];
export const children = ([l, i]: Part): [Part, Part] => {
  if (l === 0) throw new Error("Leaf memory nodes have no children");
  return [
    [l - 1, i * 2],
    [l - 1, i * 2 + 1],
  ];
};

const line = (part: Part, text: string) => `${label(part)}|${text.replace(/[\r\n]+/g, " ")}`;

export class View {
  parts: Part[] = [];
  merging = false;

  constructor(
    private readonly high: number,
    private readonly low: number,
    private readonly node: (part: Part) => Node | undefined,
  ) {}

  line(part: Part): string {
    const node = this.node(part);
    return line(part, node?.text ?? "(not summarized yet: zoom it)");
  }

  render(boundary = Infinity): string {
    const lines: string[] = [];
    const visit = (part: Part) => {
      if (start(part) >= boundary) return;
      if (end(part) <= boundary) {
        lines.push(this.line(part));
      } else if (part[0] > 0) {
        children(part).forEach(visit);
      }
    };
    for (const part of this.parts) visit(part);
    return `<chat>\n${lines.join("\n")}\n</chat>`;
  }

  get size(): number {
    return this.parts.reduce((sum, part) => sum + (this.node(part)?.size ?? 0), 0);
  }

  fit(total: number, next = false): boolean {
    const before = this.size;
    if (before <= this.high && !(next && this.merging)) return false;
    let size = before;
    const parts = [...this.parts];
    let changed = false;
    while (size > this.low) {
      let best = -1;
      let due = -Infinity;
      for (let j = 0; j + 1 < parts.length; j++) {
        const a = parts[j];
        const b = parts[j + 1];
        if (!a || !b) continue;
        if (a[0] !== b[0] || a[1] % 2 !== 0 || b[1] !== a[1] + 1) continue;
        const age = (total - (end(b) - 1)) / 2 ** a[0];
        if (age > due && this.node(parent(a))) {
          best = j;
          due = age;
        }
      }
      if (best < 0) break;
      const a = parts[best];
      const b = parts[best + 1];
      if (!a || !b) break;
      const merged = parent(a);
      size +=
        (this.node(merged)?.size ?? 0) - (this.node(a)?.size ?? 0) - (this.node(b)?.size ?? 0);
      parts.splice(best, 2, merged);
      changed = true;
    }
    if (!next && size > Math.max(this.low, before - this.high)) {
      this.merging = before > this.low;
      return false;
    }
    this.parts = parts;
    this.merging = size > this.low;
    return changed;
  }
}
