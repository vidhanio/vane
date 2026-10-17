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
    if (!node) throw new Error(`Memory node ${label(part)} is not built`);
    return line(part, node.text);
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
    return (
      16 +
      this.parts.reduce((sum, part) => sum + bytes(line(part, this.node(part)?.text ?? "")) + 1, 0)
    );
  }

  fit(total: number, force = false): boolean {
    let size = this.size;
    if (force || size > this.high) this.merging = true;
    let changed = false;
    while (this.merging && size > this.low) {
      let best = -1;
      let due = -Infinity;
      for (let j = 0; j + 1 < this.parts.length; j++) {
        const a = this.parts[j];
        const b = this.parts[j + 1];
        if (!a || !b) continue;
        if (a[0] !== b[0] || a[1] % 2 !== 0 || b[1] !== a[1] + 1) continue;
        const age = (total - (end(b) - 1)) / 2 ** a[0];
        if (age > due && this.node(parent(a))) {
          best = j;
          due = age;
        }
      }
      if (best < 0) break;
      const a = this.parts[best];
      const b = this.parts[best + 1];
      if (!a || !b) break;
      const merged = parent(a);
      size += bytes(this.line(merged)) - bytes(this.line(a)) - bytes(this.line(b)) - 1;
      this.parts.splice(best, 2, merged);
      changed = true;
    }
    if (size <= this.low) this.merging = false;
    return changed;
  }
}
