export type Part = [level: number, index: number];
export type Node = { l: number; i: number; text: string; size: number };
export const bytes = (text: string) => Buffer.byteLength(text, "utf8");
export const start = ([l, i]: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part[0];
export const key = ([l, i]: Part) => `${l}:${i}`;
export const flat = (text: string) => text.replace(/[\r\n]+/g, " ");

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
    if (!node) throw new Error(`Memory node ${start(part)}+${2 ** part[0]} is not built`);
    return `${start(part)}+${2 ** part[0]}|${flat(node.text)}`;
  }

  render(boundary = Infinity): string {
    const lines: string[] = [];
    const visit = (part: Part) => {
      if (start(part) >= boundary) return;
      if (end(part) <= boundary) {
        lines.push(this.line(part));
      } else if (part[0] > 0) {
        visit([part[0] - 1, part[1] * 2]);
        visit([part[0] - 1, part[1] * 2 + 1]);
      }
    };
    for (const part of this.parts) visit(part);
    return `<chat>\n${lines.join("\n")}\n</chat>`;
  }

  get size(): number {
    return (
      16 +
      this.parts.reduce((sum, part) => {
        const text = this.node(part)?.text ?? "";
        return sum + bytes(`${start(part)}+${2 ** part[0]}|${flat(text)}\n`);
      }, 0)
    );
  }

  fit(total: number, force = false): boolean {
    if (force || this.size > this.high) this.merging = true;
    let changed = false;
    let size = this.size;
    while (this.merging && size > this.low) {
      let best = -1;
      let due = -Infinity;
      for (let j = 0; j + 1 < this.parts.length; j++) {
        const a = this.parts[j];
        const b = this.parts[j + 1];
        if (!a || !b) continue;
        if (a[0] !== b[0] || a[1] % 2 !== 0 || b[1] !== a[1] + 1) continue;
        const age = (total - (end(b) - 1)) / 2 ** a[0];
        if (age > due && this.node([a[0] + 1, a[1] / 2])) {
          best = j;
          due = age;
        }
      }
      if (best < 0) break;
      const a = this.parts[best];
      const b = this.parts[best + 1];
      if (!a || !b) break;
      const parent: Part = [a[0] + 1, a[1] / 2];
      size += bytes(this.line(parent)) - bytes(this.line(a)) - bytes(this.line(b)) - 1;
      this.parts.splice(best, 2, parent);
      changed = true;
    }
    if (size <= this.low) this.merging = false;
    return changed;
  }
}
