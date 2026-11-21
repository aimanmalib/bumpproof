// Terminal colour that respects NO_COLOR (https://no-color.org) and non-TTY output.
export interface Paint {
  ok: (s: string) => string;
  fail: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

export function useColor(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(isTTY);
}

export function makePaint(color: boolean): Paint {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { ok: wrap(32, 39), fail: wrap(31, 39), dim: wrap(2, 22), bold: wrap(1, 22) };
}
